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

pub(crate) fn create_package() -> Result<CodexPetPackageRecord, String> {
    let pet_root = current_pet_root()?;
    fs::create_dir_all(&pet_root).map_err(|err| err.to_string())?;

    let base_id = "new-pet";
    let mut pet_id = base_id.to_string();
    let mut suffix = 1;
    while pet_root.join(&pet_id).exists() {
        pet_id = format!("{base_id}-{suffix}");
        suffix += 1;
    }

    let package_dir = pet_root.join(&pet_id);
    fs::create_dir_all(&package_dir).map_err(|err| err.to_string())?;

    let spritesheet_path = package_dir.join("spritesheet.webp");
    copy_codex_pet_template(&spritesheet_path)?;

    let manifest = CodexPetManifestInput {
        id: pet_id.clone(),
        display_name: "New Pet".to_string(),
        description: "Custom Codex pet package.".to_string(),
        spritesheet_path: "spritesheet.webp".to_string(),
    };
    let manifest_path = package_dir.join("pet.json");
    let manifest_json = serde_json::to_string_pretty(&manifest).map_err(|err| err.to_string())?;
    fs::write(&manifest_path, format!("{manifest_json}\n")).map_err(|err| err.to_string())?;

    Ok(CodexPetPackageRecord {
        id: manifest.id,
        display_name: manifest.display_name,
        description: manifest.description,
        spritesheet_path: manifest.spritesheet_path,
        spritesheet_web_path: format!("/pets/{pet_id}/spritesheet.webp"),
        package_dir: package_dir.to_string_lossy().to_string(),
        manifest_path: manifest_path.to_string_lossy().to_string(),
        spritesheet_exists: true,
        source: "custom".to_string(),
    })
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

fn read_codex_pet_manifest(path: &Path) -> Result<Option<CodexPetManifestInput>, String> {
    if !path.exists() {
        return Ok(None);
    }

    let raw = fs::read_to_string(path).map_err(|err| err.to_string())?;
    let manifest =
        serde_json::from_str::<CodexPetManifestInput>(&raw).map_err(|err| err.to_string())?;
    Ok(Some(manifest))
}

fn codex_pet_template_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(root) = project_pets_root() {
        candidates.push(root.join("omni-schnauzer/spritesheet.webp"));
        candidates.push(root.join("ikun-hoops/spritesheet.webp"));
        candidates.push(root.join("Gardevoir/spritesheet.webp"));
    }

    candidates
}

fn copy_codex_pet_template(target: &Path) -> Result<(), String> {
    for candidate in codex_pet_template_candidates() {
        if candidate.exists() {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|err| err.to_string())?;
            }
            fs::copy(&candidate, target).map_err(|err| err.to_string())?;
            return Ok(());
        }
    }

    Err("no spritesheet template was found for a new pet package".into())
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
