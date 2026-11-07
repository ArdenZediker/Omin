use crate::persona;

#[tauri::command]
pub(crate) fn read_persona_files(
    app: tauri::AppHandle,
) -> Result<persona::PersonaConfigDto, String> {
    let _operation = crate::database::maintenance::operation()?;
    persona::read_persona_files(&app)
}

#[tauri::command]
pub(crate) fn write_persona_file(
    app: tauri::AppHandle,
    key: String,
    content: String,
) -> Result<(), String> {
    let _operation = crate::database::maintenance::operation()?;
    persona::write_persona_file(&app, key, content)
}
