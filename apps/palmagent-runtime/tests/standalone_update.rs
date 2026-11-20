use anyhow::Result;
use palmagent_runtime::modules::installation::application::{Host, Operation, Request, update};
use serde_json::{Value, json};

struct InterruptedSwitch {
    compatible: bool,
    receipts: Vec<String>,
    switches: usize,
    restored: bool,
}
impl Host for InterruptedSwitch {
    fn call(&mut self, op: Operation<'_>) -> Result<Value> {
        Ok(match op {
            Operation::Resolve => {
                json!({"eligible":true,"hasPlugins":false,"refresh":false,"keep":false})
            }
            Operation::Stage => json!({"live":self.compatible,"rollback":self.compatible}),
            Operation::OpenGateway | Operation::PrepareIntent | Operation::Report { .. } => {
                Value::Null
            }
            Operation::Admission => Value::Null,
            Operation::Preferences => json!(true),
            // A previous owner already configured and launched the exact target.
            Operation::NeedsSwitch => json!(false),
            Operation::Configure | Operation::Restart => {
                self.switches += 1;
                Value::Null
            }
            Operation::Verify => anyhow::bail!("candidate is unhealthy"),
            Operation::Restore => {
                self.restored = true;
                json!(true)
            }
            Operation::RecoveryReceipt { restored } => {
                self.receipts.push(
                    if restored {
                        "restored"
                    } else {
                        "recovery-required"
                    }
                    .into(),
                );
                Value::Null
            }
            Operation::Record { reason, .. } => {
                self.receipts.push(reason.into());
                Value::Null
            }
            _ => anyhow::bail!("unexpected operation"),
        })
    }
}

#[test]
fn resumed_activation_verifies_without_relaunch_and_restores_only_compatible_storage() {
    for compatible in [true, false] {
        let mut host = InterruptedSwitch {
            compatible,
            receipts: vec![],
            switches: 0,
            restored: false,
        };
        let result = update(
            &mut host,
            Request {
                resume: compatible,
                automatic: false,
                recover_application: true,
            },
        )
        .unwrap();
        assert!(!result);
        assert_eq!(host.switches, if compatible { 0 } else { 2 });
        assert_eq!(host.restored, compatible);
        assert!(
            host.receipts.ends_with(&[
                (if compatible {
                    "handoff-activation"
                } else {
                    "application-activation"
                })
                .to_owned(),
                (if compatible {
                    "restored"
                } else {
                    "recovery-required"
                })
                .to_owned(),
                "application-activation-failed".to_owned(),
            ])
        );
    }
}

#[test]
fn retry_validates_retained_contents_and_membership_against_the_authenticated_archive() -> Result<()>
{
    use flate2::{Compression, write::GzEncoder};
    use palmagent_runtime::{
        modules::installation::adapters::outbound::archive::prepare, platform,
    };
    use sha2::{Digest, Sha256};
    use std::{fs, os::unix::fs::PermissionsExt};
    let root = std::env::temp_dir().join(platform::unique_id()?);
    let stage = root.join("stage");
    let retained = root.join("retained");
    fs::create_dir_all(&stage)?;
    let mut archive = tar::Builder::new(GzEncoder::new(Vec::new(), Compression::fast()));
    for path in [
        "palmagent/bundle.json",
        "palmagent/runtime/bin/node",
        "palmagent/app/package.json",
    ] {
        let f = retained.join(path);
        fs::create_dir_all(f.parent().unwrap())?;
        fs::write(&f, b"original")?;
        fs::set_permissions(f, fs::Permissions::from_mode(0o600))?;
        let mut header = tar::Header::new_gnu();
        header.set_mode(0o600);
        header.set_size(8);
        header.set_cksum();
        archive.append_data(&mut header, path, &b"original"[..])?;
    }
    let bytes = archive.into_inner()?.finish()?;
    fs::write(retained.join("release.tar.gz"), &bytes)?;
    let args = [
        stage.display().to_string(),
        retained.display().to_string(),
        String::new(),
        format!("{:x}", Sha256::digest(&bytes)),
        bytes.len().to_string(),
        "24".into(),
    ];
    prepare(&args)?;
    let extra = retained.join("palmagent/app/extra");
    fs::write(&extra, b"")?;
    assert!(prepare(&args).is_err());
    fs::remove_file(extra)?;
    fs::write(retained.join("palmagent/runtime/bin/node"), b"modified")?;
    assert!(prepare(&args).is_err());
    fs::remove_dir_all(root)?;
    Ok(())
}
