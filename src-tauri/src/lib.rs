//! The Mac app shell. The game itself is the web page; this side only gives it the player's own
//! Total Annihilation files: it remembers which folder holds them, lists the archives there and
//! reads byte ranges from them. Nothing from the game is bundled with the app.

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{ipc::Response, AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

const ARCHIVE_EXTENSIONS: [&str; 5] = ["hpi", "ufo", "ccx", "gpf", "gp3"];

#[derive(Serialize, Deserialize, Default)]
struct Settings {
    data_dir: Option<String>,
}

#[derive(Serialize)]
struct Archive {
    name: String,
    size: u64,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

fn load_settings(app: &AppHandle) -> Settings {
    settings_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_settings(app: &AppHandle, s: &Settings) -> Result<(), String> {
    let text = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    fs::write(settings_path(app)?, text).map_err(|e| e.to_string())
}

fn is_archive(name: &str) -> bool {
    name.rsplit_once('.')
        .map(|(_, ext)| ARCHIVE_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn archives_in(dir: &str) -> Vec<Archive> {
    let mut list: Vec<Archive> = fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().to_string();
                    let meta = e.metadata().ok()?;
                    (meta.is_file() && is_archive(&name)).then_some(Archive { name, size: meta.len() })
                })
                .collect()
        })
        .unwrap_or_default();
    list.sort_by(|a, b| a.name.cmp(&b.name));
    list
}

/// The remembered game folder, if it still holds archives.
#[tauri::command]
fn data_dir(app: AppHandle) -> Option<String> {
    load_settings(&app).data_dir.filter(|d| !archives_in(d).is_empty())
}

/// Asks the player for their Total Annihilation folder and remembers it if it holds archives.
/// Returns the folder, or an error message to show.
#[tauri::command]
async fn choose_data_dir(app: AppHandle) -> Result<Option<String>, String> {
    let Some(picked) = app.dialog().file().set_title("Choose your Total Annihilation folder").blocking_pick_folder() else {
        return Ok(None);
    };
    let dir = picked.into_path().map_err(|e| e.to_string())?.to_string_lossy().to_string();
    if archives_in(&dir).is_empty() {
        return Err("That folder has no TA archives (.hpi, .ufo, .ccx, .gp3). Pick the folder with totala1.hpi in it.".into());
    }
    save_settings(&app, &Settings { data_dir: Some(dir.clone()) })?;
    Ok(Some(dir))
}

#[tauri::command]
fn list_archives(app: AppHandle) -> Vec<Archive> {
    data_dir(app).map(|d| archives_in(&d)).unwrap_or_default()
}

/// Reads `length` bytes at `offset` from one archive in the game folder.
#[tauri::command]
fn read_range(app: AppHandle, name: String, offset: u64, length: u64) -> Result<Response, String> {
    if name.contains('/') || name.contains('\\') || !is_archive(&name) {
        return Err(format!("not an archive name: {name}"));
    }
    let dir = data_dir(app).ok_or("no game folder chosen")?;
    let mut f = File::open(PathBuf::from(dir).join(&name)).map_err(|e| e.to_string())?;
    f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; length as usize];
    f.read_exact(&mut buf).map_err(|e| e.to_string())?;
    Ok(Response::new(buf))
}

/// Appends a line to log.txt next to the settings, so problems in the app can be looked into later.
#[tauri::command]
fn app_log(app: AppHandle, line: String) -> Result<(), String> {
    use std::io::Write;
    let path = settings_path(&app)?.with_file_name("log.txt");
    // Keep the log small: start over once it passes 1 MB.
    let append = fs::metadata(&path).map(|m| m.len() < 1_000_000).unwrap_or(true);
    let mut f = fs::OpenOptions::new().create(true).write(true).append(append).truncate(!append).open(path).map_err(|e| e.to_string())?;
    writeln!(f, "{line}").map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![data_dir, choose_data_dir, list_archives, read_range, app_log])
        .run(tauri::generate_context!())
        .expect("error while running the app");
}
