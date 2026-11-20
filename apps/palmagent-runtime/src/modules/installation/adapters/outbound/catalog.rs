use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signature, VerifyingKey, pkcs8::DecodePublicKey};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::process::Command;

const MAX_DOCUMENT: usize = 2 * 1024 * 1024;
const TRUST: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../packages/shared/src/release-trust.json"
));
const DISTRIBUTION: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../packages/shared/src/distribution.json"
));

fn metadata(url: &str) -> Result<Vec<u8>> {
    let output = Command::new("curl")
        .args([
            "--fail",
            "--silent",
            "--show-error",
            "--location",
            "--proto",
            "=https",
            "--proto-redir",
            "=https",
            "--connect-timeout",
            "10",
            "--max-time",
            "30",
            "--max-filesize",
            &MAX_DOCUMENT.to_string(),
            "--url",
            url,
        ])
        .output()?;
    ensure!(
        output.status.success() && output.stdout.len() <= MAX_DOCUMENT,
        "Release metadata unavailable"
    );
    Ok(output.stdout)
}

fn verified(bytes: &[u8]) -> Result<Value> {
    let trust: Value = serde_json::from_str(TRUST)?;
    let envelope: Value = serde_json::from_slice(bytes)?;
    ensure!(
        envelope["schemaVersion"] == 1,
        "Unsupported signature envelope"
    );
    let payload = STANDARD.decode(
        envelope["payload"]
            .as_str()
            .context("Missing signed payload")?,
    )?;
    let signatures = envelope["signatures"]
        .as_array()
        .context("Missing signatures")?;
    ensure!(
        !payload.is_empty() && (1..=8).contains(&signatures.len()),
        "Invalid signed envelope"
    );
    for sig in signatures {
        let Some(pem) = sig["keyId"]
            .as_str()
            .and_then(|id| trust["keys"].get(id))
            .and_then(Value::as_str)
        else {
            continue;
        };
        let der = STANDARD.decode(
            pem.lines()
                .filter(|s| !s.starts_with("-----"))
                .collect::<String>(),
        )?;
        let key = VerifyingKey::from_public_key_der(&der)?;
        let Some(signature) = sig["signature"]
            .as_str()
            .and_then(|s| STANDARD.decode(s).ok())
            .and_then(|b| Signature::from_slice(&b).ok())
        else {
            continue;
        };
        if key.verify_strict(&payload, &signature).is_ok() {
            return Ok(serde_json::from_slice(&payload)?);
        }
    }
    anyhow::bail!("Release signature is not trusted")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Index {
    schema_version: u8,
    channel: String,
    revision: u64,
    version: String,
    release_manifest_url: String,
    release_manifest_sha256: String,
}

fn version(s: &str) -> bool {
    let digits = |v: &str| !v.is_empty() && v.bytes().all(|c| c.is_ascii_digit());
    let (base, pre) = s.split_once('-').map_or((s, None), |(v, p)| (v, Some(p)));
    base.split('.').count() == 3
        && base.split('.').all(digits)
        && pre.is_none_or(|p| {
            p.split_once('.')
                .is_some_and(|(kind, n)| matches!(kind, "alpha" | "beta" | "rc") && digits(n))
        })
}

pub fn select(channel: &str, requested: Option<&str>, target: &str) -> Result<Value> {
    ensure!(
        matches!(channel, "preview" | "stable"),
        "Invalid update channel"
    );
    let distribution: Value = serde_json::from_str(DISTRIBUTION)?;
    let repository = distribution["repositoryUrl"]
        .as_str()
        .context("Missing repository origin")?;
    let origin = distribution["releaseOrigin"]
        .as_str()
        .context("Missing release origin")?;
    let index = if requested.is_none() {
        let doc = metadata(&format!("{origin}/channels/{channel}.json"))?;
        let index: Index = serde_json::from_value(verified(&doc)?)?;
        ensure!(
            index.schema_version == 1
                && index.channel == channel
                && (1..=9007199254740991).contains(&index.revision),
            "Invalid channel identity"
        );
        Some(index)
    } else {
        None
    };
    let selected = requested
        .or_else(|| index.as_ref().map(|i| i.version.as_str()))
        .context("Missing target version")?;
    ensure!(
        version(selected) && (channel != "stable" || !selected.contains('-')),
        "Invalid release version for channel"
    );
    let url = format!("{repository}/releases/download/v{selected}/standalone.json");
    ensure!(
        index.as_ref().is_none_or(|i| i.release_manifest_url == url),
        "Channel manifest URL mismatch"
    );
    let bytes = metadata(&url)?;
    let digest = format!("{:x}", Sha256::digest(&bytes));
    ensure!(
        index
            .as_ref()
            .is_none_or(|i| i.release_manifest_sha256 == digest),
        "Channel manifest checksum mismatch"
    );
    let manifest = verified(&bytes)?;
    ensure!(
        manifest["version"] == selected,
        "Signed manifest version mismatch"
    );
    let artifacts = manifest["artifacts"]
        .as_array()
        .context("Missing platform artifacts")?;
    for artifact in artifacts {
        let filename = artifact["filename"]
            .as_str()
            .context("Missing artifact name")?;
        ensure!(
            artifact["url"] == format!("{repository}/releases/download/v{selected}/{filename}"),
            "Artifact URL differs from official release"
        );
    }
    let artifact = artifacts
        .iter()
        .find(|a| a["target"] == target)
        .context("No artifact for this platform")?;
    Ok(
        json!({"manifest":manifest,"selection":{"distribution":"standalone","version":selected,
        "manifestUrl":url,"manifestSha256":digest,"artifact":artifact}}),
    )
}
