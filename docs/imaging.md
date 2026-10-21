# Image enhancements

The “Enhancements” section in the left bar opens a page with tabs:

- **Upscale** — Real-ESRGAN on the user's GPU (WebGPU, ONNX Runtime Web 1.30) ×2/×3/×4 or Magnific (Creative / Precision V2) ×2…×16.
- **Background** — background removal with BiRefNet-lite on the GPU, optionally cropped to the object.
- **Generate** — on the GPU (SD-Turbo, no keys, 512×512) or Nano Banana (Gemini with image output), optionally with the current image as a reference (Nano Banana only).
- **Graphs** — a node editor (like Blueprints in Unreal): your own pipelines such as “Prompts → Create → Remove background → Fit to size → To page”, a batch of prompts or images, results as frames on the file's pages. Custom nodes from a group of nodes and node presets; graphs are personal (in the browser) or shared (in the file, for the team).

Source: a file, Ctrl+V, “Take from selection” or **“From project…”** (a layer image from any file of the team). Result of any tab: “Replace in document” (for a layer image; for an image from another file, “Replace in “file”” and “Revert”), “Insert on page”, “Continue with result” (it becomes the source — for example, upscale and then remove the background right away), “Download PNG”.

## Connections and keys

- Each user has their own keys, in this browser's localStorage (`mfp-imaging`), like the assistant key. The “Connections” window: Google key check (list of image models) and Magnific key check (list of tasks, free).
- Nano Banana: Google accepts requests from the browser (CORS verified), the key goes only to Google. Default model `gemini-nano-banana-2.1`, the list comes from the API for the key (Google renames models often). Request: `v1beta/models/{model}:generateContent`, `responseModalities: ['IMAGE']`, `imageConfig {aspectRatio, imageSize}`; for a model without size support, the request is retried without it.
- Magnific: the Magnific and Freepik APIs are not reachable from the browser (CORS — verified), so requests go through the MFP server: `apps/server/src/imaging-proxy.ts`, `/api/imaging/magnific/<path>` → `api.magnific.com` (header `x-magnific-api-key`) or `api.freepik.com` (`x-freepik-api-key`). Only upscaler paths are forwarded; the key is neither stored nor logged. The finished image is fetched directly from the CDN first, and on CORS failure through `/api/imaging/fetch?url=` (https only, no IP addresses or internal networks after DNS, up to 3 redirects with the same check, image/* only, up to 128 MB). In the closed beta, `/api/*` requires sign-in anyway.

## Generation on the GPU (SD-Turbo)

- Without a Google key, the default is “On the GPU”. Model: the ONNX Runtime Web build `schmuell/sd-turbo-ort-web` (revision `ace89b7d…`): text encoder 681 MB, UNet 1.73 GB, VAE 99 MB, CLIP tokenizer — 2.5 GB in total. The browser downloads them from Hugging Face on first run (progress in the status line) and puts them into Cache Storage `mfp-imaging-sd-turbo`; they are neither in git nor on our server. “Remove from browser” clears the cache.
- Pipeline (`worker.ts`): CLIP tokenizer (`clip-tokenizer.ts`, checked against transformers.CLIPTokenizer on 6 prompts, including “!” and truncation to 77) → text encoder → 1–4 UNet steps with Euler from the model's `scheduler_config` (timestep_spacing trailing, scaled_linear, epsilon; σ(999)=14.615) → VAE (÷0.18215) → PNG 512×512. Seed: mulberry32 + Box–Muller; empty means random.
- UNet runs in a nested worker `sd-unet-worker.ts` (each ORT instance has its own WebAssembly memory, limited to 4 GB) with `graphOptimizationLevel: 'disabled'`: the optimizer folds constants into fp32 copies of the weights, and the 1.73 GB UNet throws `std::bad_alloc` (verified: disabled — session in 5.5 s, basic/all — bad_alloc).
- Requires `shader-f16` (like the Microsoft build). Prompts must be in English (CLIP).
- **License: Stability AI Community License.** Free for research, personal and commercial use with revenue up to $1M per year; commercial use requires registration at stability.ai/community-license. The required notice “Powered by Stability AI” is shown in the generation tab and in the tooltip of the “Create” node; text: `apps/editor/public/upscaler/NOTICE.md`. The build repository contains the old non-commercial license (11.2023); the weights are Stability's, and the current SD-Turbo license is the Community License (07.2024).

## Graphs (nodes)

- Canvas: nodes with colored headers by group (input, text, generation, processing, output, custom), pins of two types — image (circle) and text (diamond); a wire is dragged from pin to pin of the same type only, without cycles. A wire dropped on empty space opens the node palette filtered to nodes with a matching input — the new node connects automatically. A wire can be detached from a connected input and moved; Alt+click on a pin or wire disconnects it.
- Right-click or double-click on empty space opens the palette with search (arrows, Enter). Wheel zooms at the cursor; held right button or wheel pans; a selection box selects (Shift/Ctrl adds). Del, Ctrl+D, Ctrl+C/V (also between graphs), Ctrl+A, Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y (graph snapshots, 100 steps), F shows everything or the selection, Ctrl+G combines into a custom node.
- Nodes: “Prompts” (batch source: each line is a run, `name | prompt` sets the name), “Images” (source: files, Ctrl+V, drag and drop, “From selection” — kept only in the tab's memory), “Text”, “Template” (`{text}`), “Create” (Auto / GPU / Nano Banana, template `{prompt}`, optional reference), “Upscale” (Auto / GPU / Magnific), “Remove background”, “Fit to size”, “To page” (page by name, created if missing; a suffix such as `/200` is appended to the name).
- Execution (`nodes/runner.ts`): for each batch item only the nodes that “To page” depends on are computed, each once (branches after a shared node do not recompute it). An item's outputs are placed in one row on their page (`PagePlacer.placeRow`), and the row is one undo step of the document. The running node is highlighted, and the wire into it is animated. A graph error (required input not connected, no output, a cycle) stops the batch; a service error affects only its own item. “Stop” aborts both the network request and the GPU task. While a batch is running, the graph cannot be edited.
- “Auto” works as before: Nano Banana / Magnific when a key is set, otherwise the GPU.
- **Custom nodes.** Select nodes → right-click → “Combine into custom node…”: wires crossing the boundary become pins (duplicate names get numbers), and the selection is replaced with one node; “Ungroup into nodes” restores them. Sources and “To page” are not included in a custom node. **Preset**: right-click a node → “Save as preset…”: its settings (for example, a prompt template) become a separate palette item with that name.
- **Storage.** “My graphs”, custom nodes and presets are kept in the browser (`mfp-imaging-library`); on first open, old chains (`mfp-imaging-chains`) are converted into graphs. “Export all” / “Import…” use a JSON file (`format: mfp-imaging`) for another browser or project; a single graph has “Download JSON”. **“Share in file”** puts a copy of the graph into `sharedPluginData` of the document root (namespace `mfp-imaging`, key `graph:<id>`): it is saved and synced with the file and visible to everyone who has the file. A graph from the file is edited in place (written 0.6 s after an edit), and colleagues' edits arrive on the canvas. Custom nodes used by the graph travel inside it. Sharing a graph with the same name again updates its copy in the file.
- A shared graph lives at the file level, not the project level: MFP has no server-side project storage. Keys and presets stay personal.

## Images from projects

- The “Images from projects” window (`picker.ts`): on the left — the open file, teams → projects → files (`/api/projects/:id`), “Drafts” and “Shared with me” (`/api/files?scope=…`); in the middle — pages with image counts; on the right — layers with an image fill (searched in depth), search by name, “Select all”, selection across pages and files. Previews are downscaled copies from the server (`/image/<sha1>?size=256`), loaded on scroll. Another file is read as a snapshot (`GET /api/files/:id/doc` → Loro → document); the open file is read from the editor's live document.
- Where: “From project…” in the “Upscale” and “Background” tabs (one image; double-click takes it right away) and in the “Images” source of graphs (several images). The item name has the size suffix removed (“sword/200” → “sword”).
- The **“Replace in document”** node puts the new image into the same layer it came from (via “From selection” or “From project”). “Layer size”: “Keep” or “Match image” — the layer takes the image size, and the name “sword/200” becomes “sword/256”. This is how ready-made icons are resized: “Images (from project) → Fit to size 256 → Replace in document (match image)”.
- Writing (`projects.ts`, `ImageWriter`): in the open file, an edit of the editor's document, one group per layer (Ctrl+Z); in another file, the image is uploaded to the server (`PUT /image/<sha1>`), the snapshot is edited and the Loro update is sent with `POST /api/files/:id/doc` (as with branches; the CRDT merges it with edits from people in the file). Before replacing, it checks that the layer still holds the same image. The layer's previous properties (fill, size, name) are remembered: “Revert replacements (N)” after a graph run and “Revert” in the tab. Without edit permission: “No permission to edit file …”. A tile fill (TILE) keeps the pattern size.

## How it works

- `apps/editor/src/imaging/`: `page.ts` (page, tabs, layer menu, `installImaging` — two lines in `main.ts`), `engine.ts` (task queue to the worker), `worker.ts` (tiled Real-ESRGAN and BiRefNet), `nodes/` (`model.ts` — data, combining/ungrouping custom nodes, chain migration; `runner.ts` — execution; `defs.ts` — built-in nodes; `services.ts` — GPU, Nano Banana, Magnific; `canvas.ts` — canvas; `view.ts` — tab; `shared.ts` — graphs in the file), `document.ts` (replace/insert/page/placement), `gemini.ts`, `magnific.ts`, `keys.ts`, `resize.ts`, `png.ts`.
- While the page is open, keys and clipboard events inside it do not reach the document (intercepted on `window`, installed at module import — before the `main.ts` handlers); windows on top of the page and an open menu handle their own keys, and the graph canvas receives keys from this interceptor.
- Background removal: input 1024×1024 (ImageNet normalization), sigmoid → mask, stretched to the image size and multiplied by the source alpha. Cropping uses alpha > 8. For a layer from the document, cropping is turned off (otherwise the result could not go back into the same layer).

## Models

Real-ESRGAN models are in `apps/editor/public/upscaler` (in git). BiRefNet-lite is not shipped: the editor
downloads it from the source on the first background removal (pinned revision, SHA-256 check) and keeps it in
the browser cache (`mfp-imaging-matte`); offline, background removal works only if the model is already downloaded.

| file | purpose | size | license |
|---|---|---|---|
| realesr-general-x4v3.fp16/fp32 | Upscale “Fast” | 2.3 / 4.6 MB | BSD-3 (xinntao/Real-ESRGAN) |
| realesr-x4plus.fp16/fp32 | “Quality” | 32 / 64 MB | BSD-3 |
| realesr-x4plus-anime.fp16/fp32 | “Drawings” | 8.6 / 17 MB | BSD-3 |
| birefnet-lite.fp16 (downloaded) | Background removal | 110 MB | MIT |

Real-ESRGAN: `tools/upscaler/convert-models.py`. BiRefNet-lite: the ready-made export [jiabins0303/birefnet-lite-1024-webgpu](https://huggingface.co/jiabins0303/birefnet-lite-1024-webgpu) (`onnx/model_fp16.onnx`, SHA256 `4059896039dfccb0f15b9080ff06d11d90e499449bb045e797055eb8901cf5f4`): original weights ZhengPeng7/BiRefNet_lite, graph rewritten for WebGPU (deformable convolutions via Gather, Split into ≤6 outputs). A regular BiRefNet export does not work in ORT Web. Only fp16 is available, so background removal is unavailable on GPUs without `shader-f16`. Caveat from the export's author: the DIS5K training set has its own restrictions on commercial use.

## Verified (12.10.2026, RTX 5070, Edge with WebGPU via CDP, dev server + branch server on 5186)

- Background: a 1400×900 bear render — cut out with the saddle and harness; with cropping 979×819 in 13 s (including the first model load), repeated runs ~3–8 s. Layer in the document: “Remove background…” in the menu → “Replace in document” → the corner is transparent, the 700×450 layer is unchanged, Undo restores the original.
- Chain “remove background → 200, 450” on 2 images: 9 s, page “Icons test” created, 4 frames 200×200/450×450 with a transparent background and PNG export, the second row at y=530; “Open page” switches to it.
- Chain “Icons” with a fake Google key: each prompt shows the Google error in the queue, names come from “name | prompt”.
- Generation and Google key check with a fake key: Google's message “API key not valid”; without a key the button is disabled, and the chain opens “Connections”.
- Magnific through the server: fake key → a real 401 response from both api.magnific.com and api.freepik.com; a foreign path — 404, no key — 401; fetch to 127.0.0.1, localhost, http — 400; not an image — 502; google.com favicon — 200. The CORS preflight allows the key headers.
- GPU upscaling after the rework: 1400×900 ×2 in 2 s; “Continue with result” makes the result the source.
- Esc in the “Connections” window closes the window, the page stays open.
- 766 tests / 152 files (new: imaging-png, imaging-proxy), typecheck of all projects, `vite build`.

- Generation on the GPU (12.10.2026, RTX 5070): downloading 2.5 GB from Hugging Face ~4 min (≈10 MB/s), then from the cache; the first run after page load takes 20 s (model preparation), then 1.6 s per 512×512 image in 2 steps. Chain “Icons” without keys (Auto → SD-Turbo → background → 200 + 450) on 2 prompts — 19 s. The pipeline was checked against a Python reference (onnxruntime CPU, same formulas): meaningful images at 1 and 2 steps. 769 tests (new: imaging-clip).

- Node graphs (12.10.2026, Edge with WebGPU via CDP, real mouse and keyboard events): an old chain was converted into a graph (7 nodes, 8 wires), without chains — the “Icons” graph; right-click palette with search and Enter; wire from pin to pin, text does not connect to image; a wire dropped on empty space — palette with matching nodes only, “To page” connected automatically; selection box, Delete, Ctrl+Z/redo, Ctrl+D; Shift/Ctrl+click and Ctrl+G / right-click → “Combine into custom node” (pins “Prompt → Image”), “Ungroup into nodes” and Ctrl+Z; a preset from the “Fit to size” node and from an import — added as a node on the canvas; the library and the graph survived a page reload; JSON import. Run “Prompts → custom node (SD-Turbo + background) → 200 and 450” on 2 prompts — 21 s, frames `sword/200`, `sword/450`, `potion/200`, `potion/450` in rows on “Icons”, the running node highlighted; “Images” (drag-and-dropped file) → background → 200 → page “No background” — 5.6 s, the canvas locked during the run. “Share in file” → graph in `sharedPluginData`, a rename was written to the document, an edit “from the server” appeared on the canvas. Esc closes the palette and the node menu, not the page; without them — the page. 774 tests / 154 files (imaging-nodes: batch with branches, custom node = same result, combine/ungroup, chain migration, graph errors, document snapshot with a file graph), typecheck of all projects, `vite build`.

- Images from projects (12.10.2026, branch server on 5186 with team “Icon test” → project “Game” → file “Game icons”: three 200×200 frames): the window showed the team, projects, “Drafts”, “Shared with me”, pages with image counts and previews from the server; “Select all” → graph “Images → Fit 256 → Replace (match image)” — in the file on the server (verified by reading its snapshot) `potion/256`, `sword/256`, `bear/256` 256×256 with new images; “Revert replacements (3)” — back to `/200` 200×200 with the previous ones. “Upscale” tab: double-click on “bear/200” → ×2 → “Replace in “Game icons”” — the layer image in the file is new, the layer is 200×200; “Revert” — the previous one. Unit tests (imaging-projects): names and sizes, tile fill, the “already replaced” check, the open file with Ctrl+Z and revert, a file “on the server” through real Loro (image upload, update merge, revert), the “Replace” node without the image's origin — an error. 780 tests, typecheck.

## Not verified

- **Real Nano Banana generation and real Magnific upscaling** — no keys; requests and response parsing follow the Google and Magnific documentation (12.10.2026). Needs a check with the user's keys.
- The CDN host from which Magnific serves results, and whether it allows direct browser access, is unknown (a fallback through the server exists).
- A graph in a file used by two people at once through the server (the document snapshot and an edit applied as if received from outside were verified); concurrent edits to the same graph — the last write wins.
- “From project” and replacement for a second person who has the same file open at that moment (the update goes through the server, as with branches, and should reach them live); files with tens of thousands of layers in the picker (a page is scanned in full).
- Graphs with Nano Banana and Magnific — without keys, only the GPU paths were verified.
- Weak GPUs, GPUs without `shader-f16`, WebView2 in the MFP app, Firefox/Safari; background removal on very large images (the 1024 mask is stretched, so edges are softer).
- SD-Turbo on GPUs with little memory (needs ~3 GB of video memory) and on machines with little RAM (loading the UNet takes ~5 GB of process memory).
- SD-Turbo quality is draft-level (512×512, poorly follows “on a white background”, objects are sometimes wrong): Nano Banana is better for final icons.

## Rollback

Remove the `installImaging(...)` line and its import in `apps/editor/src/main.ts` — the section disappears; remove the `imagingProxy` line in `apps/server/src/server.ts` — forwarding disappears. Full rollback: revert the commits of the `feature/upscaler` branch.
