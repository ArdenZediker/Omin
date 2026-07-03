use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexPetPackageRecord {
    id: String,
    display_name: String,
    description: String,
    spritesheet_path: String,
    spritesheet_web_path: String,
    package_dir: String,
    manifest_path: String,
    spritesheet_exists: bool,
    source: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexPetPackageListPayload {
    packages: Vec<CodexPetPackageRecord>,
    active_pet_id: Option<String>,
    codex_home: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexPetManifestInput {
    id: String,
    display_name: String,
    description: String,
    spritesheet_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportCodexPetPackageInput {
    source_dir: String,
}

pub(crate) fn load_workspace_pet_dir() -> Result<String, String> {
    Ok(current_pet_root()?.to_string_lossy().to_string())
}

pub(crate) fn load_packages() -> Result<CodexPetPackageListPayload, String> {
    let pet_root = current_pet_root()?;
    fs::create_dir_all(&pet_root).map_err(|err| err.to_string())?;

    let mut packages = Vec::new();
    for entry in fs::read_dir(&pet_root).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        let package_dir = entry.path();
        if !package_dir.is_dir() {
            continue;
        }

        if let Some(record) = load_codex_pet_package_record(&package_dir)? {
            packages.push(record);
        }
    }

    packages.sort_by(|left, right| {
        left.display_name
            .to_lowercase()
            .cmp(&right.display_name.to_lowercase())
            .then_with(|| left.id.cmp(&right.id))
    });

    let active_pet_id = packages
        .iter()
        .find(|package| package.spritesheet_exists)
        .or_else(|| packages.first())
        .map(|package| package.id.clone());

    Ok(CodexPetPackageListPayload {
        packages,
        active_pet_id,
        codex_home: pet_root.to_string_lossy().to_string(),
    })
}

pub(crate) fn import_package(
    input: ImportCodexPetPackageInput,
) -> Result<CodexPetPackageRecord, String> {
    let source_dir = PathBuf::from(input.source_dir.trim());
    if !source_dir.is_dir() {
        return Err("请选择一个有效的宠物文件夹。".into());
    }

    let source_manifest_path = source_dir.join("pet.json");
    let manifest = read_codex_pet_manifest(&source_manifest_path)?
        .ok_or_else(|| "宠物文件夹缺少 pet.json。".to_string())?;
    let pet_id = validate_codex_pet_id(&manifest.id)?;
    let display_name = manifest.display_name.trim();
    if display_name.is_empty() {
        return Err("pet.json 中的 displayName 不能为空。".into());
    }
    if manifest.description.trim().is_empty() {
        return Err("pet.json 中的 description 不能为空。".into());
    }

    let spritesheet_path = validate_relative_pet_asset_path(&manifest.spritesheet_path)?;
    let source_spritesheet_path = source_dir.join(&spritesheet_path);
    if !source_spritesheet_path.is_file() {
        return Err(format!(
            "宠物文件夹缺少贴图文件：{}",
            spritesheet_path.to_string_lossy()
        ));
    }

    let pet_root = current_pet_root()?;
    fs::create_dir_all(&pet_root).map_err(|err| err.to_string())?;
    let package_dir_name = reserve_import_package_dir_name(&pet_root, &pet_id);
    let target_dir = pet_root.join(&package_dir_name);
    prevent_recursive_import(&source_dir, &target_dir)?;
    copy_pet_package_dir(&source_dir, &target_dir)?;

    let target_manifest_path = target_dir.join("pet.json");
    let mut target_manifest = manifest;
    target_manifest.id = package_dir_name.clone();
    let manifest_json =
        serde_json::to_string_pretty(&target_manifest).map_err(|err| err.to_string())?;
    fs::write(&target_manifest_path, format!("{manifest_json}\n"))
        .map_err(|err| err.to_string())?;

    load_codex_pet_package_record(&target_dir)?
        .ok_or_else(|| "导入宠物后未能读取宠物配置。".to_string())
}

fn validate_codex_pet_id(value: &str) -> Result<String, String> {
    let normalized = value.trim().to_lowercase();
    if normalized.is_empty() {
        return Err("pet id is required".into());
    }

    if !normalized
        .chars()
        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-' || ch == '_')
    {
        return Err(
            "pet id may only contain lowercase letters, digits, hyphen, or underscore".into(),
        );
    }

    Ok(normalized)
}

fn validate_relative_pet_asset_path(value: &str) -> Result<PathBuf, String> {
    let normalized = value.trim().replace('\\', "/");
    if normalized.is_empty() {
        return Err("pet.json 中的 spritesheetPath 不能为空。".into());
    }
    let path = PathBuf::from(&normalized);
    if path.is_absolute() || normalized.split('/').any(|part| part == "..") {
        return Err("spritesheetPath 必须是宠物文件夹内的相对路径。".into());
    }
    Ok(path)
}

fn reserve_import_package_dir_name(pet_root: &Path, base_id: &str) -> String {
    let mut package_dir_name = base_id.to_string();
    let mut suffix = 1;
    while pet_root.join(&package_dir_name).exists() {
        package_dir_name = format!("{base_id}-{suffix}");
        suffix += 1;
    }
    package_dir_name
}

fn prevent_recursive_import(source_dir: &Path, target_dir: &Path) -> Result<(), String> {
    let source_dir = source_dir.canonicalize().map_err(|err| err.to_string())?;
    let target_parent = target_dir
        .parent()
        .ok_or_else(|| "导入目标目录无效。".to_string())?
        .canonicalize()
        .map_err(|err| err.to_string())?;
    let target_name = target_dir
        .file_name()
        .ok_or_else(|| "导入目标目录无效。".to_string())?;
    let target_dir = target_parent.join(target_name);

    if target_dir.starts_with(&source_dir) {
        return Err("请选择具体宠物包文件夹，不能选择宠物根目录或其上级目录。".into());
    }

    Ok(())
}

fn copy_pet_package_dir(source_dir: &Path, target_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(target_dir).map_err(|err| err.to_string())?;
    for entry in fs::read_dir(source_dir).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        let source_path = entry.path();
        let target_path = target_dir.join(entry.file_name());
        let file_type = entry.file_type().map_err(|err| err.to_string())?;
        if file_type.is_dir() {
            copy_pet_package_dir(&source_path, &target_path)?;
        } else if file_type.is_file() {
            fs::copy(&source_path, &target_path).map_err(|err| err.to_string())?;
        }
    }
    Ok(())
}

fn read_codex_pet_manifest(path: &Path) -> Result<Option<CodexPetManifestInput>, String> {
    if !path.exists() {
        return Ok(None);
    }

    let raw = fs::read_to_string(path).map_err(|err| err.to_string())?;
    let manifest =
        serde_json::from_str::<CodexPetManifestInput>(&raw).map_err(|err| err.to_string())?;
    Ok(Some(manifest))
}

fn load_codex_pet_package_record(
    package_dir: &Path,
) -> Result<Option<CodexPetPackageRecord>, String> {
    let manifest_path = package_dir.join("pet.json");
    let Some(manifest) = read_codex_pet_manifest(&manifest_path)? else {
        return Ok(None);
    };

    let id = validate_codex_pet_id(&manifest.id)?;
    let display_name = manifest.display_name.trim().to_string();
    let description = manifest.description.trim().to_string();
    let spritesheet_path = manifest.spritesheet_path.trim().to_string();
    let spritesheet_file_path = package_dir.join(&spritesheet_path);
    let spritesheet_exists = spritesheet_file_path.exists();
    let package_name = package_dir
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(&id);
    let spritesheet_web_path = format!(
        "/pets/{package_name}/{}",
        spritesheet_path.replace('\\', "/")
    );

    Ok(Some(CodexPetPackageRecord {
        id,
        display_name,
        description,
        spritesheet_path,
        spritesheet_web_path,
        package_dir: package_dir.to_string_lossy().to_string(),
        manifest_path: manifest_path.to_string_lossy().to_string(),
        spritesheet_exists,
        source: "custom".to_string(),
    }))
}

fn project_pets_root() -> Result<PathBuf, String> {
    let root = crate::workspace_root()?;
    let pets_root = root.join("public").join("pets");
    fs::create_dir_all(&pets_root).map_err(|err| err.to_string())?;
    Ok(pets_root)
}

fn current_pet_root() -> Result<PathBuf, String> {
    project_pets_root()
}
