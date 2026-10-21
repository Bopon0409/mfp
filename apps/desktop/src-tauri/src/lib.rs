// MFP desktop: a Tauri shell around the web editor (apps/editor).
//
// Only what the browser lacks lives here:
// - files on disk: chunked reads (a huge .fig is never read into memory whole),
//   atomic writes (temp file + rename), folders, moving to the trash — only our own
//   folders and files the user picked (scope.rs); the “Open” and “Save” dialogs live here too;
// - system fonts without a permission prompt (fontdb + names from the name table);
// - files opened from the system (.mfp, .fig, .sketch, .pdf): at startup and on a second launch.

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

mod scope;
use scope::Scope;

/// Files passed at startup (double click on .mfp / .fig): the editor picks them up itself.
struct Startup(Mutex<Vec<String>>);

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// File paths among the command-line arguments.
fn file_args<I: IntoIterator<Item = String>>(args: I) -> Vec<String> {
    args.into_iter()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .filter(|a| {
            let l = a.to_lowercase();
            [".mfp", ".fig", ".sketch", ".pdf"].iter().any(|e| l.ends_with(e)) && Path::new(a).exists()
        })
        .collect()
}

/// A line to the app output and to the log (desktop debugging: the editor's startup report).
#[tauri::command]
fn log(message: String) {
    println!("[mfp] {message}");
    append_log(&[format!("{} [сведения] {message}", now_stamp())]);
}

// ---------- Error log ----------
//
// <app data>/logs/mfp-YYYY-MM-DD.log: editor errors and warnings (log_append)
// and crashes of the shell itself (panic hook). One week, a file per day. It never leaves the
// computer on its own — “Report a problem” puts it into an archive that the user saves themselves.

static LOG_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);
const LOG_DAYS: usize = 7;

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Date (UTC) from seconds since 1970: “2026-10-07” (civil_from_days, Howard Hinnant).
fn civil_date(secs: u64) -> String {
    let z = (secs / 86_400) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}")
}

fn now_stamp() -> String {
    let s = now_secs();
    format!("{}T{:02}:{:02}:{:02}Z", civil_date(s), s % 86_400 / 3600, s % 3600 / 60, s % 60)
}

fn append_log(lines: &[String]) {
    let Some(dir) = LOG_DIR.lock().ok().and_then(|d| d.clone()) else {
        return;
    };
    let path = dir.join(format!("mfp-{}.log", civil_date(now_secs())));
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(path) {
        for l in lines {
            let _ = writeln!(f, "{l}");
        }
    }
}

/// Log files, by date (oldest first).
fn log_files(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .map(|r| {
            r.filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.starts_with("mfp-") && n.ends_with(".log"))
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

/// Log folder (MFP_LOG_DIR overrides it for tests); files older than a week are deleted.
fn init_log(app: &AppHandle) {
    let dir = match std::env::var_os("MFP_LOG_DIR") {
        Some(d) => PathBuf::from(d),
        None => match app.path().app_data_dir() {
            Ok(d) => d.join("logs"),
            Err(_) => return,
        },
    };
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let names = log_files(&dir);
    for n in &names[..names.len().saturating_sub(LOG_DAYS)] {
        let _ = fs::remove_file(dir.join(n));
    }
    if let Ok(mut d) = LOG_DIR.lock() {
        *d = Some(dir);
    }
}

#[tauri::command]
fn log_append(lines: Vec<String>) {
    append_log(&lines);
}

/// Logs of the last `days` days as one text (at most a 2 MB tail from each).
#[tauri::command]
fn read_logs(days: u32) -> String {
    let Some(dir) = LOG_DIR.lock().ok().and_then(|d| d.clone()) else {
        return String::new();
    };
    let names = log_files(&dir);
    let mut out = String::new();
    for n in &names[names.len().saturating_sub(days as usize)..] {
        let Ok(text) = fs::read_to_string(dir.join(n)) else {
            continue;
        };
        let mut start = text.len().saturating_sub(2_000_000);
        while !text.is_char_boundary(start) {
            start += 1;
        }
        out.push_str(&format!("===== {n} =====\n"));
        out.push_str(&text[start..]);
    }
    out
}

#[tauri::command]
fn startup_paths(state: State<Startup>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap())
}

// ---------- Files ----------

#[derive(serde::Serialize)]
struct Entry {
    name: String,
    path: String,
    dir: bool,
    size: u64,
    /// Modification time, ms since 1970.
    modified: f64,
}

fn entry(path: &Path) -> Option<Entry> {
    let meta = fs::metadata(path).ok()?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0);
    Some(Entry {
        name: path.file_name()?.to_string_lossy().into_owned(),
        path: path.to_string_lossy().into_owned(),
        dir: meta.is_dir(),
        size: if meta.is_dir() { 0 } else { meta.len() },
        modified,
    })
}

#[tauri::command]
fn stat(scope: State<Scope>, path: String) -> Option<Entry> {
    scope.readable(Path::new(&path)).ok()?;
    entry(Path::new(&path))
}

/// Folder contents: subfolders and files (hidden ones — starting with a dot — are skipped).
#[tauri::command]
fn list_dir(scope: State<Scope>, path: String) -> Result<Vec<Entry>, String> {
    scope.readable(Path::new(&path))?;
    let mut out = Vec::new();
    for item in fs::read_dir(&path).map_err(err)? {
        let item = item.map_err(err)?;
        let name = item.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        if let Some(e) = entry(&item.path()) {
            out.push(e);
        }
    }
    Ok(out)
}

#[tauri::command]
fn read_file(scope: State<Scope>, path: String) -> Result<Response, String> {
    scope.readable(Path::new(&path))?;
    fs::read(&path).map(Response::new).map_err(err)
}

/// A piece of a file (the .fig import reads the archive in parts).
#[tauri::command]
fn read_range(scope: State<Scope>, path: String, offset: u64, length: u64) -> Result<Response, String> {
    scope.readable(Path::new(&path))?;
    let mut f = File::open(&path).map_err(err)?;
    f.seek(SeekFrom::Start(offset)).map_err(err)?;
    let mut buf = Vec::with_capacity(length as usize);
    f.take(length).read_to_end(&mut buf).map_err(err)?;
    Ok(Response::new(buf))
}

fn header_path(request: &Request<'_>) -> Result<PathBuf, String> {
    let raw = request
        .headers()
        .get("x-path")
        .ok_or("нет заголовка x-path")?
        .to_str()
        .map_err(err)?;
    Ok(PathBuf::from(percent_decode(raw)?))
}

/// Write a whole file: into a temp file next to it, then rename (a failure never damages the old file).
#[tauri::command]
fn write_file(scope: State<Scope>, request: Request<'_>) -> Result<(), String> {
    let path = header_path(&request)?;
    scope.writable(&path)?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("ожидались байты".into());
    };
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(err)?;
    }
    let tmp = path.with_extension(format!(
        "{}.tmp-mfp",
        path.extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default()
    ));
    {
        let mut f = File::create(&tmp).map_err(err)?;
        f.write_all(bytes).map_err(err)?;
        f.sync_all().map_err(err)?;
    }
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

#[tauri::command]
fn make_dir(scope: State<Scope>, path: String) -> Result<(), String> {
    // A new folder: the nearest existing ancestor is checked (normalize needs an existing parent).
    let mut probe = PathBuf::from(&path);
    while !probe.exists() {
        if !probe.pop() {
            return Err(format!("Нет доступа к папке: {path}"));
        }
    }
    scope.writable(&probe)?;
    fs::create_dir_all(path).map_err(err)
}

/// Rename or move (never overwrites an existing file).
#[tauri::command]
fn rename_path(scope: State<Scope>, from: String, to: String) -> Result<(), String> {
    scope.renamable(Path::new(&from), Path::new(&to))?;
    if Path::new(&to).exists() {
        return Err(format!("уже есть: {to}"));
    }
    fs::rename(from, to).map_err(err)
}

/// Delete — to the system trash (it can be restored from there).
#[tauri::command]
fn trash_path(scope: State<Scope>, path: String) -> Result<(), String> {
    scope.writable(Path::new(&path))?;
    trash::delete(path).map_err(err)
}

/// App folders: user files (Documents/MFP) and service data.
#[tauri::command]
fn app_dirs(app: AppHandle) -> Result<(String, String), String> {
    let docs = app.path().document_dir().map_err(err)?.join("MFP");
    let data = app.path().app_data_dir().map_err(err)?;
    fs::create_dir_all(&docs).map_err(err)?;
    fs::create_dir_all(&data).map_err(err)?;
    Ok((docs.to_string_lossy().into_owned(), data.to_string_lossy().into_owned()))
}

// ---------- File dialogs ----------
//
// The “Open” and “Save” dialogs are shown by the shell: the path the user picks goes straight into
// the allowed list (scope.rs). Dialogs opened from the page don't add to the list.

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct PickOptions {
    title: Option<String>,
    default_path: Option<String>,
    multiple: bool,
    directory: bool,
    filter_name: Option<String>,
    extensions: Vec<String>,
}

fn file_dialog(app: &AppHandle, o: &PickOptions) -> tauri_plugin_dialog::FileDialogBuilder<tauri::Wry> {
    let mut b = app.dialog().file();
    if let Some(w) = app.get_webview_window("main") {
        b = b.set_parent(&w);
    }
    if let Some(t) = &o.title {
        b = b.set_title(t);
    }
    if let Some(d) = &o.default_path {
        let p = Path::new(d);
        if o.directory || p.is_dir() {
            b = b.set_directory(p);
        } else {
            if let Some(parent) = p.parent().filter(|x| x.is_absolute()) {
                b = b.set_directory(parent);
            }
            if let Some(name) = p.file_name() {
                b = b.set_file_name(name.to_string_lossy());
            }
        }
    }
    if !o.directory && !o.extensions.is_empty() {
        let exts: Vec<&str> = o.extensions.iter().map(String::as_str).collect();
        b = b.add_filter(o.filter_name.clone().unwrap_or_default(), &exts);
    }
    b
}

/// “Open”: the picked files (or folder) as paths; cancel — empty.
#[tauri::command]
async fn pick_open(app: AppHandle, scope: State<'_, Scope>, options: PickOptions) -> Result<Vec<String>, String> {
    let b = file_dialog(&app, &options);
    let picked: Vec<PathBuf> = if options.directory {
        b.blocking_pick_folder().and_then(|p| p.into_path().ok()).into_iter().collect()
    } else if options.multiple {
        b.blocking_pick_files().unwrap_or_default().into_iter().filter_map(|p| p.into_path().ok()).collect()
    } else {
        b.blocking_pick_file().and_then(|p| p.into_path().ok()).into_iter().collect()
    };
    if options.directory {
        for d in &picked {
            scope.grant_dir(d);
        }
    } else {
        scope.grant_files(&picked);
    }
    Ok(picked.iter().map(|p| p.to_string_lossy().into_owned()).collect())
}

/// “Save”: the path (without an extension — with the first of `extensions`); cancel — null.
#[tauri::command]
async fn pick_save(app: AppHandle, scope: State<'_, Scope>, options: PickOptions) -> Result<Option<String>, String> {
    let Some(mut path) = file_dialog(&app, &options).blocking_save_file().and_then(|p| p.into_path().ok()) else {
        return Ok(None);
    };
    if let Some(ext) = options.extensions.first() {
        if !path.extension().is_some_and(|x| x.to_string_lossy().eq_ignore_ascii_case(ext)) {
            let mut s = path.into_os_string();
            s.push(".");
            s.push(ext);
            path = PathBuf::from(s);
        }
    }
    scope.grant_files(&[&path]);
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Migration from an older version: the paths of “Recent” (once, while there is no picked-files list yet).
#[tauri::command]
fn scope_migrate(scope: State<Scope>, paths: Vec<String>) -> usize {
    scope.migrate(&paths)
}

fn percent_decode(s: &str) -> Result<String, String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).map_err(err)?;
            out.push(u8::from_str_radix(hex, 16).map_err(err)?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(err)
}

// ---------- Office server (“Share on the network”) ----------
//
// The MFP server from the office folder next to the program (Node.js + the server as one module, scripts/build-office.ts):
// data in <app data>/office, sign-in with username and password, the editor for colleagues' browsers. The process
// never outlives the app: on Windows it runs in a Job Object with KILL_ON_JOB_CLOSE, even if the app crashes.

struct OfficeProc {
    child: std::process::Child,
    port: u16,
    setup: std::sync::Arc<Mutex<Option<String>>>,
}

struct Office(Mutex<Option<OfficeProc>>);

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct OfficeInfo {
    running: bool,
    port: u16,
    /// This computer's addresses on the local network (for colleagues).
    addresses: Vec<String>,
    /// First-setup code (a server without accounts).
    setup_code: Option<String>,
}

/// Local network address: the interface of the default route (a UDP connect sends no packets).
fn lan_addresses() -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(s) = std::net::UdpSocket::bind("0.0.0.0:0") {
        if s.connect("192.0.2.1:9").is_ok() {
            if let Ok(a) = s.local_addr() {
                if !a.ip().is_loopback() && !a.ip().is_unspecified() {
                    out.push(a.ip().to_string());
                }
            }
        }
    }
    out
}

fn free_port(want: u16) -> Option<u16> {
    (want..want.saturating_add(20)).find(|p| std::net::TcpListener::bind(("0.0.0.0", *p)).is_ok())
}

#[cfg(windows)]
fn tie_to_app(child: &std::process::Child) {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    // The job is not closed: the system closes it when the app exits — and that stops the server.
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        AssignProcessToJobObject(job, child.as_raw_handle() as _);
    }
}

#[cfg(not(windows))]
fn tie_to_app(_child: &std::process::Child) {}

fn office_info(p: Option<&mut OfficeProc>) -> OfficeInfo {
    if let Some(p) = p {
        if matches!(p.child.try_wait(), Ok(None)) {
            return OfficeInfo {
                running: true,
                port: p.port,
                addresses: lan_addresses(),
                setup_code: p.setup.lock().ok().and_then(|s| s.clone()),
            };
        }
    }
    OfficeInfo { running: false, port: 0, addresses: lan_addresses(), setup_code: None }
}

/// Start the office server (already running — return its info). `port` is preferred; if busy — the next free one.
#[tauri::command]
fn office_start(app: AppHandle, state: State<Office>, port: u16) -> Result<OfficeInfo, String> {
    let mut guard = state.0.lock().map_err(err)?;
    if let Some(p) = guard.as_mut() {
        if matches!(p.child.try_wait(), Ok(None)) {
            return Ok(office_info(Some(p)));
        }
    }
    let dir = app.path().resource_dir().map_err(err)?.join("office");
    let node = dir.join(if cfg!(windows) { "node.exe" } else { "node" });
    if !node.exists() {
        return Err("В этой сборке нет офисного сервера (папка office рядом с программой)".into());
    }
    // MFP_OFFICE_DATA — another folder (e2e tests don't touch the user's data).
    let data = match std::env::var_os("MFP_OFFICE_DATA") {
        Some(d) => PathBuf::from(d),
        None => app.path().app_data_dir().map_err(err)?.join("office"),
    };
    fs::create_dir_all(&data).map_err(err)?;
    let port = free_port(port).ok_or("Нет свободного порта для сервера")?;
    let host = lan_addresses().into_iter().next().unwrap_or_else(|| "localhost".into());
    let mut cmd = std::process::Command::new(&node);
    cmd.arg(dir.join("server").join("main.mjs"))
        .current_dir(&dir)
        .env("PORT", port.to_string())
        .env("MFP_DATA", &data)
        .env("MFP_STATIC", dir.join("editor"))
        .env("MFP_AUTH", "password")
        // All addresses of the computer; MFP_OFFICE_HOST=127.0.0.1 — only the computer itself (e2e tests).
        .env("HOST", std::env::var("MFP_OFFICE_HOST").unwrap_or_default())
        .env("MFP_APP_URL", format!("http://{host}:{port}/"))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console window
    }
    let mut child = cmd.spawn().map_err(err)?;
    tie_to_app(&child);
    // Server output goes to the app log; the first-setup code — to the “Share on the network” window.
    let setup = std::sync::Arc::new(Mutex::new(None::<String>));
    if let Some(out) = child.stdout.take() {
        let setup = setup.clone();
        std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::BufReader::new(out).lines().map_while(Result::ok) {
                if let Some(i) = line.find("введите код ") {
                    let code: String = line[i + "введите код ".len()..].chars().take(9).collect();
                    if let Ok(mut s) = setup.lock() {
                        *s = Some(code);
                    }
                }
                append_log(&[format!("{} [офис] {line}", now_stamp())]);
            }
        });
    }
    if let Some(errs) = child.stderr.take() {
        std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::BufReader::new(errs).lines().map_while(Result::ok) {
                append_log(&[format!("{} [офис, ошибка] {line}", now_stamp())]);
            }
        });
    }
    *guard = Some(OfficeProc { child, port, setup });
    Ok(office_info(guard.as_mut()))
}

#[tauri::command]
fn office_status(state: State<Office>) -> Result<OfficeInfo, String> {
    let mut guard = state.0.lock().map_err(err)?;
    Ok(office_info(guard.as_mut()))
}

/// Stop the office server (colleagues get disconnected; the data stays).
#[tauri::command]
fn office_stop(state: State<Office>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(err)?;
    if let Some(mut p) = guard.take() {
        let _ = p.child.kill();
        let _ = p.child.wait();
    }
    Ok(())
}

// ---------- Updates ----------
//
// The editor chooses the update address: the company server (closed network) or MFP releases on GitHub.
// An update's signature is checked with the public key from tauri.conf.json, so the file can't be swapped.

#[derive(serde::Serialize)]
struct UpdateInfo {
    version: String,
    notes: String,
}

fn updater(app: &AppHandle, endpoint: &str) -> Result<tauri_plugin_updater::Updater, String> {
    use tauri_plugin_updater::UpdaterExt;
    let url = endpoint.parse().map_err(err)?;
    app.updater_builder().endpoints(vec![url]).map_err(err)?.build().map_err(err)
}

/// Whether the update server has a newer version (the latest.json address).
#[tauri::command]
async fn update_check(app: AppHandle, endpoint: String) -> Result<Option<UpdateInfo>, String> {
    let found = updater(&app, &endpoint)?.check().await.map_err(err)?;
    Ok(found.map(|u| UpdateInfo { version: u.version.clone(), notes: u.body.clone().unwrap_or_default() }))
}

/// Download and install the new version; `progress` is the downloaded fraction (0…1).
#[tauri::command]
async fn update_install(app: AppHandle, endpoint: String, progress: tauri::ipc::Channel<f64>) -> Result<(), String> {
    let Some(update) = updater(&app, &endpoint)?.check().await.map_err(err)? else {
        return Err("Новой версии уже нет на сервере".into());
    };
    let mut got = 0u64;
    update
        .download_and_install(
            |chunk, total| {
                got += chunk as u64;
                if let Some(t) = total.filter(|t| *t > 0) {
                    let _ = progress.send((got as f64 / t as f64).min(1.0));
                }
            },
            || {},
        )
        .await
        .map_err(err)
}

// ---------- Fonts ----------

#[derive(serde::Serialize)]
struct FontFace {
    family: String,
    style: String,
    path: String,
    index: u32,
}

/// A name from the name table: the typographic one first (16 / 17), otherwise the regular one (1 / 2).
fn face_names(data: &[u8], index: u32) -> Option<(String, String)> {
    let face = ttf_parser::Face::parse(data, index).ok()?;
    let pick = |ids: &[u16]| -> Option<String> {
        for id in ids {
            for name in face.names() {
                if name.name_id == *id && name.is_unicode() {
                    if let Some(s) = name.to_string() {
                        if !s.is_empty() {
                            return Some(s);
                        }
                    }
                }
            }
        }
        None
    };
    let family = pick(&[ttf_parser::name_id::TYPOGRAPHIC_FAMILY, ttf_parser::name_id::FAMILY])?;
    let style = pick(&[ttf_parser::name_id::TYPOGRAPHIC_SUBFAMILY, ttf_parser::name_id::SUBFAMILY]).unwrap_or_else(|| "Regular".into());
    Some((family, style))
}

/// System fonts: family, style, file (like queryLocalFonts, but without a permission prompt).
#[tauri::command]
async fn list_fonts(scope: State<'_, Scope>) -> Result<Vec<FontFace>, String> {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();
    let mut out = Vec::new();
    for f in db.faces() {
        let path = match &f.source {
            fontdb::Source::File(p) => p.clone(),
            fontdb::Source::SharedFile(p, _) => p.clone(),
            _ => continue,
        };
        let names = db.with_face_data(f.id, |data, index| face_names(data, index)).flatten();
        let (family, style) = match names {
            Some(n) => n,
            None => match f.families.first() {
                Some((family, _)) => (family.clone(), "Regular".into()),
                None => continue,
            },
        };
        out.push(FontFace {
            family,
            style,
            path: path.to_string_lossy().into_owned(),
            index: f.index,
        });
    }
    // Font files are read-only (the editor loads them by these paths).
    let paths: Vec<&str> = out.iter().map(|f| f.path.as_str()).collect();
    scope.grant_fonts(&paths);
    Ok(out)
}

// ---------- Closing ----------
//
// The editor closes the window itself: it hides the window, finishes writing files and calls destroy. While writing,
// it sends a heartbeat every 2 s (closing_alive). No heartbeat for 20 s (the UI hung) or writing takes longer
// than 3 minutes — we exit on our own: disk writes are atomic (the old file is intact), and so is the working copy.

/// The window is closing (hidden and finishing writing files).
static CLOSING: AtomicBool = AtomicBool::new(false);
/// Close number: a cancelled close stops its own watchdog.
static CLOSE_GEN: AtomicU64 = AtomicU64::new(0);
/// The editor's last heartbeat while closing.
static ALIVE: Mutex<Option<Instant>> = Mutex::new(None);

#[tauri::command]
fn closing_alive() {
    *ALIVE.lock().unwrap() = Some(Instant::now());
}

/// Closing cancelled: writing failed and the user kept the window, or a file was opened again.
#[tauri::command]
fn close_cancelled() {
    CLOSING.store(false, Ordering::SeqCst);
    CLOSE_GEN.fetch_add(1, Ordering::SeqCst);
}

fn close_watchdog(app: &AppHandle) {
    if CLOSING.swap(true, Ordering::SeqCst) {
        return;
    }
    let gen = CLOSE_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let start = Instant::now();
    *ALIVE.lock().unwrap() = Some(start);
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        if !CLOSING.load(Ordering::SeqCst) || CLOSE_GEN.load(Ordering::SeqCst) != gen {
            return;
        }
        let silent = ALIVE.lock().unwrap().map_or(Duration::ZERO, |t| t.elapsed());
        if silent > Duration::from_secs(20) || start.elapsed() > Duration::from_secs(180) {
            append_log(&[format!(
                "{} [внимание] Сторож закрытия: знаков жизни нет {} с, закрытие идёт {} с — выход",
                now_stamp(),
                silent.as_secs(),
                start.elapsed().as_secs()
            )]);
            app.exit(0);
            std::thread::sleep(Duration::from_secs(5));
            std::process::exit(0);
        }
    });
}

// ---------- Startup ----------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // A shell crash goes to the log (the build uses panic = abort: the write completes before exit).
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        append_log(&[format!("{} [ошибка] Падение оболочки: {info}", now_stamp())]);
        default_hook(info);
    }));
    let mut builder = tauri::Builder::default();
    #[cfg(desktop)]
    {
        // Second launch (a file opened from Explorer while the window exists): the files go to this window.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let paths = file_args(argv);
            app.state::<Scope>().grant_files(&paths);
            // The window is closing (hidden, finishing writing files): bring it back with these files.
            if CLOSING.load(Ordering::SeqCst) {
                let _ = app.emit("reopen", paths);
                return;
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            if !paths.is_empty() {
                let _ = app.emit("open-paths", paths);
            }
        }));
    }
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Startup(Mutex::new(file_args(std::env::args()))))
        .manage(Office(Mutex::new(None)))
        .manage(Scope::default())
        .setup(|app| {
            init_log(app.handle());
            // Tests (scripts/e2e-desktop.ts) run in the background: the window is off screen, without a
            // taskbar button and without focus — it doesn't get in the way of using the computer.
            if std::env::var_os("MFP_E2E_BACKGROUND").is_some() {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.set_skip_taskbar(true);
                    let _ = w.set_focusable(false);
                    let _ = w.set_position(tauri::PhysicalPosition::new(-20000, -20000));
                }
            }
            // Allowed paths: our own folders, the program folder (read-only), files from the launch arguments.
            let path = app.path();
            // Folders not found (an unusual system) — don't fail: just allow less.
            let data = path.app_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("mfp"));
            let mut rw = vec![data.clone()];
            rw.extend(path.document_dir().ok().map(|d| d.join("MFP")));
            let ro: Vec<PathBuf> = path.resource_dir().into_iter().collect();
            let scope = app.state::<Scope>();
            // MFP_SCOPE_FILE — tests use their own list (scripts/e2e-desktop.ts), so the real one stays untouched.
            let store = std::env::var_os("MFP_SCOPE_FILE").map(PathBuf::from).unwrap_or_else(|| data.join(scope::STORE));
            scope.init(&rw, &ro, store);
            scope.grant_files(&app.state::<Startup>().0.lock().unwrap());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Presentation windows close as usual; finishing writing files before exit applies only to the editor.
            if window.label() != "main" {
                return;
            }
            // The editor is closed — open presentation windows are not needed without it: exit the app.
            if let tauri::WindowEvent::Destroyed = event {
                window.app_handle().exit(0);
                return;
            }
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // The window goes away at once, even if the UI is busy: it finishes writing files without a window.
                let _ = window.hide();
                close_watchdog(window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            log,
            startup_paths,
            stat,
            list_dir,
            read_file,
            read_range,
            write_file,
            make_dir,
            rename_path,
            trash_path,
            app_dirs,
            list_fonts,
            closing_alive,
            close_cancelled,
            log_append,
            read_logs,
            update_check,
            update_install,
            office_start,
            office_status,
            office_stop,
            pick_open,
            pick_save,
            scope_migrate
        ])
        .run(tauri::generate_context!())
        .expect("не удалось запустить MFP");
}
