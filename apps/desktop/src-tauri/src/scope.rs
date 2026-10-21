// Which files the editor window may read and write.
//
// File commands (read_file, write_file, …) take a path from the page. If foreign code ever got into
// the page (a vulnerability, a malicious file), without limits it could read any file on the computer.
// So paths are checked here, in the shell:
// - our own folders — Documents/MFP and the app service folder — entirely;
// - the program folder — read-only (mfp-company.json, lang.txt);
// - system fonts — read-only (their paths come from list_fonts);
// - files the user picked: the open or save dialog (pick_open, pick_save — the dialogs are shown by
//   the shell, not the page), a double click in Explorer (launch arguments). Picked files are
//   remembered (granted-files.json in the service folder), so “Recent” files open after a restart.
//   A folder picked for export can be written to until the app closes.
// The page can't add a path to the list itself: only through the dialogs and Explorer.
// The exception is migration from an older version: once, while there is no list yet, the page
// passes the paths of “Recent” (scope_migrate), otherwise they would stop opening.

use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

/// How many picked files to remember (older ones are forgotten).
const MAX_FILES: usize = 5000;
pub const STORE: &str = "granted-files.json";

#[derive(Default)]
struct Inner {
    /// Whole folders: read and write.
    roots: Vec<PathBuf>,
    /// Whole folders: read-only.
    read_roots: Vec<PathBuf>,
    /// Picked files (in the order they were picked — for MAX_FILES).
    files: Vec<PathBuf>,
    file_set: HashSet<String>,
    /// System fonts: read-only.
    fonts: HashSet<String>,
    /// The file with the picked-files list; None — nowhere to save it.
    store: Option<PathBuf>,
    /// The list already existed (no migration from an older version needed).
    had_store: bool,
}

#[derive(Default)]
pub struct Scope(Mutex<Inner>);

/// Comparison key: Windows paths are case-insensitive.
fn key(p: &Path) -> String {
    let s = p.to_string_lossy().into_owned();
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}

/// A full path without “..” and links: an existing one — as the system sees it; a new file — its folder as
/// the system sees it plus the name. Relative paths and “..” in the name are rejected.
pub fn normalize(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    if let Ok(p) = fs::canonicalize(path) {
        return Some(p);
    }
    let name = path.file_name()?;
    if matches!(Path::new(name).components().next(), Some(Component::ParentDir | Component::CurDir)) {
        return None;
    }
    let parent = fs::canonicalize(path.parent()?).ok()?;
    Some(parent.join(name))
}

fn under(path: &Path, roots: &[PathBuf]) -> bool {
    let k = key(path);
    roots.iter().any(|r| {
        let rk = key(r);
        k == rk || k.strip_prefix(&rk).is_some_and(|rest| rest.starts_with(std::path::MAIN_SEPARATOR))
    })
}

impl Scope {
    /// Our own folders and the picked-files list (at startup).
    pub fn init(&self, rw: &[PathBuf], ro: &[PathBuf], store: PathBuf) {
        let mut s = self.0.lock().unwrap();
        for d in rw {
            let _ = fs::create_dir_all(d);
            if let Some(p) = normalize(d) {
                s.roots.push(p);
            }
        }
        for d in ro {
            if let Some(p) = normalize(d) {
                s.read_roots.push(p);
            }
        }
        if let Ok(text) = fs::read_to_string(&store) {
            s.had_store = true;
            if let Ok(list) = serde_json::from_str::<Vec<String>>(&text) {
                for f in list {
                    let p = PathBuf::from(f);
                    if s.file_set.insert(key(&p)) {
                        s.files.push(p);
                    }
                }
            }
        }
        s.store = Some(store);
    }

    fn save(s: &mut Inner) {
        while s.files.len() > MAX_FILES {
            let old = s.files.remove(0);
            s.file_set.remove(&key(&old));
        }
        if let Some(store) = &s.store {
            let list: Vec<String> = s.files.iter().map(|p| p.to_string_lossy().into_owned()).collect();
            if let Ok(text) = serde_json::to_string(&list) {
                let tmp = store.with_extension("json.tmp");
                if fs::write(&tmp, text).is_ok() {
                    let _ = fs::rename(&tmp, store);
                }
            }
        }
    }

    /// The user picked a file (a dialog, Explorer): it may be read and written.
    pub fn grant_files<P: AsRef<Path>>(&self, paths: &[P]) {
        let mut s = self.0.lock().unwrap();
        for p in paths {
            let Some(n) = normalize(p.as_ref()) else { continue };
            let k = key(&n);
            // Already there — move it to the end (a recently picked file is forgotten last).
            if s.file_set.contains(&k) {
                s.files.retain(|x| key(x) != k);
            } else {
                s.file_set.insert(k);
            }
            s.files.push(n);
        }
        Self::save(&mut s);
    }

    /// A folder picked by the user (exporting several files): until the app closes.
    pub fn grant_dir(&self, dir: &Path) {
        if let Some(n) = normalize(dir) {
            self.0.lock().unwrap().roots.push(n);
        }
    }

    pub fn grant_fonts<P: AsRef<Path>>(&self, paths: &[P]) {
        let mut s = self.0.lock().unwrap();
        for p in paths {
            if let Some(n) = normalize(p.as_ref()) {
                s.fonts.insert(key(&n));
            }
        }
    }

    /// Migration from an older version: only while there is no picked-files list yet, and only existing
    /// document files. Returns how many were accepted.
    pub fn migrate(&self, paths: &[String]) -> usize {
        if self.0.lock().unwrap().had_store {
            return 0;
        }
        let ok: Vec<&String> = paths
            .iter()
            .filter(|p| {
                let l = p.to_lowercase();
                [".mfp", ".fig", ".sketch", ".pdf"].iter().any(|e| l.ends_with(e)) && Path::new(p).is_file()
            })
            .collect();
        self.grant_files(&ok);
        self.0.lock().unwrap().had_store = true;
        ok.len()
    }

    fn check(&self, path: &Path, write: bool) -> Result<PathBuf, String> {
        let n = normalize(path).ok_or_else(|| format!("Нет доступа к файлу: {}", path.display()))?;
        let s = self.0.lock().unwrap();
        let k = key(&n);
        let ok = under(&n, &s.roots) || s.file_set.contains(&k) || (!write && (under(&n, &s.read_roots) || s.fonts.contains(&k)));
        if ok {
            Ok(n)
        } else {
            Err(format!("Нет доступа к файлу: {} — откройте его через «Открыть…»", path.display()))
        }
    }

    pub fn readable(&self, path: &Path) -> Result<PathBuf, String> {
        self.check(path, false)
    }

    pub fn writable(&self, path: &Path) -> Result<PathBuf, String> {
        self.check(path, true)
    }

    /// Renaming: inside our own folders — like writing; a picked file — within the same folder, and the new
    /// name becomes picked too.
    pub fn renamable(&self, from: &Path, to: &Path) -> Result<(), String> {
        let f = self.writable(from)?;
        if self.writable(to).is_ok() {
            return Ok(());
        }
        let t = normalize(to).ok_or("Нет доступа к файлу")?;
        if f.parent().map(key) == t.parent().map(key) {
            self.grant_files(&[t]);
            return Ok(());
        }
        Err(format!("Нет доступа к файлу: {}", to.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_rules() {
        let base = std::env::temp_dir().join(format!("mfp-scope-{}", std::process::id()));
        let own = base.join("own");
        let other = base.join("other");
        let res = base.join("res");
        for d in [&own, &other, &res] {
            fs::create_dir_all(d).unwrap();
        }
        fs::write(other.join("a.mfp"), b"x").unwrap();
        fs::write(other.join("secret.txt"), b"x").unwrap();
        fs::write(res.join("lang.txt"), b"en").unwrap();
        let s = Scope::default();
        s.init(&[own.clone()], &[res.clone()], base.join(STORE));

        assert!(s.writable(&own.join("new.mfp")).is_ok());
        assert!(s.readable(&res.join("lang.txt")).is_ok());
        assert!(s.writable(&res.join("lang.txt")).is_err());
        assert!(s.readable(&other.join("secret.txt")).is_err());
        assert!(s.readable(&own.join("..").join("other").join("secret.txt")).is_err());
        assert!(s.readable(Path::new("relative.mfp")).is_err());

        // Migration from an older version: documents only, and only once.
        assert_eq!(s.migrate(&[other.join("a.mfp").to_string_lossy().into(), other.join("secret.txt").to_string_lossy().into()]), 1);
        assert!(s.readable(&other.join("a.mfp")).is_ok());
        assert!(s.readable(&other.join("secret.txt")).is_err());
        assert_eq!(s.migrate(&[other.join("secret.txt").to_string_lossy().into()]), 0);

        // Renaming a picked file — within the same folder.
        assert!(s.renamable(&other.join("a.mfp"), &other.join("b.mfp")).is_ok());
        assert!(s.writable(&other.join("b.mfp")).is_ok());
        assert!(s.renamable(&other.join("a.mfp"), &res.join("b.mfp")).is_err());

        // The picked-files list survives a restart.
        let again = Scope::default();
        again.init(&[own.clone()], &[], base.join(STORE));
        assert!(again.readable(&other.join("a.mfp")).is_ok());
        assert_eq!(again.migrate(&[other.join("secret.txt").to_string_lossy().into()]), 0);

        let _ = fs::remove_dir_all(&base);
    }
}
