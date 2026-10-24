use palmagent_runtime::modules::routines::adapters::outbound::calendar::next_run;
use serde_json::Value;

#[test]
fn calendar_matches_typescript_vectors() {
    // Generated from the existing TypeScript nextRun implementation. Each zone runs in
    // its own process; changing a process-global timezone during parallel tests is unsafe.
    let vectors: Value = serde_json::from_str(include_str!("fixtures/calendar.json")).unwrap();
    if let Ok(zone) = std::env::var("PALMAGENT_TEST_CALENDAR_ZONE") {
        let cases = vectors
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["timezone"] == zone)
            .unwrap();
        for case in cases["cases"].as_array().unwrap() {
            let schedule = case["schedule"].as_str().unwrap();
            let from = case["from"].as_i64().unwrap();
            assert_eq!(
                next_run(schedule, from).unwrap(),
                case["next"].as_i64(),
                "{zone}: {schedule}, from {from}"
            );
        }
    } else {
        for entry in vectors.as_array().unwrap() {
            let zone = entry["timezone"].as_str().unwrap();
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "calendar_matches_typescript_vectors",
                    "--nocapture",
                ])
                .env("TZ", zone)
                .env("PALMAGENT_TEST_CALENDAR_ZONE", zone)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }
}
