#!/usr/bin/env python3
"""Isolated, synthetic build/IPC experiment. Never contacts a provider or live service."""
import argparse
import concurrent.futures
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import random
import resource
import selectors
import shutil
import signal
import socket
import subprocess
import tempfile
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
PARSER = ROOT / "apps/server/src/modules/agents/adapters/outbound/model-catalog.ts"
TYPES = ROOT / "packages/shared/src/model-catalog.ts"


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def corpus():
    typical = {"data": [{"model": f"model-{i}", "isDefault": i == 0,
                         "supportedReasoningEfforts": ["low", "medium", "high"]}
                        for i in range(8)], "accountId": "synthetic-discarded-field"}
    cases = [typical, {}, None, [], True, 12, "text", {"data": []},
             {"data": [], "models": [{"id": "ignored"}]},
             {"data": False, "models": [{"id": "fallback"}]},
             {"models": [None, [], 1, {"model": 12, "id": "ignored"},
                         {"model": "default"}, {"model": "hidden", "hidden": True},
                         {"model": "  a\n\t b  ", "isDefault": True,
                          "supportedReasoningEfforts": ["default", " low ", {"effort": "low"},
                              {"reasoningEffort": None, "value": "high"}, {"reasoningEffort": False, "value": "ignored"}]},
                         {"id": "a b", "isDefault": True, "supportedReasoningEfforts": ["ignored"]},
                         {"model": "last", "isDefault": True, "supportedReasoningEfforts": ["max"]}]},
             {"data": [{"model": "x" * 159 + "😀"}, {"model": "x" * 160 + "suffix"}]},
             {"data": [{"model": "\ufeff\u00a0한글\u2028", "supportedReasoningEfforts": ["🚀" * 100]}]},
             {"data": [{"model": "a" * 160 + str(i)} for i in range(4)]},
             {"data": [{"model": f"m-{i}", "supportedReasoningEfforts": [f"e-{j}" for j in range(70)]} for i in range(140)]},
             {"data": [{"hidden": True, "model": "hidden"}] * 128 + [{"model": "ignored"}]},
             {"data": [{"model": "one", "supportedReasoningEfforts": [None] * 64 + ["ignored"]}]}]
    rng = random.Random(240)
    names = [None, False, 4, "", "default", "alpha", " beta\n gamma ", "한글", "🦀", "\u0085", "\ufeff x ", "x" * 162]
    for _ in range(120):
        rows = []
        for _ in range(rng.randrange(1, 24)):
            rows.append({"model": rng.choice(names), "id": rng.choice(names),
                         "hidden": rng.choice([True, False, None, "true", 1]),
                         "isDefault": rng.choice([True, False, None, "true", 1]),
                         "supportedReasoningEfforts": rng.choice([None, [], names, [{"value": v} for v in names]])})
        cases.append({rng.choice(["data", "models"]): rows})
    return cases


def command(argv, cwd, env, log, timeout=900):
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    load = os.getloadavg()
    started = time.perf_counter()
    with open(log, "wb") as output:
        process = subprocess.Popen(argv, cwd=cwd, env=env, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            code = process.wait(timeout)
        except BaseException:
            try: os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError: pass
            try: process.wait(5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL); process.wait(5)
            raise
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    if code:
        raise RuntimeError(f"Command failed ({code}); inspect {log}")
    return {"wallMs": (time.perf_counter() - started) * 1000,
            "cpuMs": (after.ru_utime + after.ru_stime - before.ru_utime - before.ru_stime) * 1000,
            "loadBefore": list(load), "loadAfter": list(os.getloadavg())}


def replace_once(path, before, after):
    text = path.read_text()
    if text.count(before) != 1:
        raise RuntimeError(f"Expected one edit anchor in {path.name}")
    path.write_text(text.replace(before, after))


def prepare(work, node):
    source = PARSER.read_text()
    if source.count("// No prompt or turn is sent.") != 1:
        raise RuntimeError("Parser extraction boundary changed")
    prefix = source.split("// No prompt or turn is sent.")[0]
    if "export function parseCodexModelCatalog" not in prefix:
        raise RuntimeError("Parser extraction boundary changed")
    prefix = "\n".join(line for line in prefix.splitlines() if not line.startswith("import "))
    prefix = 'import type { CodexModelCatalog, CodexModelCatalogModel, ModelCatalogChoice } from "./contract.js";\nconst MAX_TEXT_UNITS = 160;\n' + prefix
    if prefix.count(".slice(0, 160)") != 1:
        raise RuntimeError("Parser truncation contract changed")
    prefix = prefix.replace(".slice(0, 160)", ".slice(0, MAX_TEXT_UNITS)")
    for variant, template in [("ts", "ts"), ("go", "go"), ("rust-dev", "rust"), ("rust-release", "rust")]:
        shutil.copytree(HERE / template, work / variant, ignore=shutil.ignore_patterns("target", "__pycache__"))
        if template == "rust": shutil.copy2(ROOT / "rust-toolchain.toml", work / variant / "rust-toolchain.toml")
    ts = work / "ts"
    (ts / "model.ts").write_text(prefix)
    (ts / "contract.ts").write_text(TYPES.read_text() + "\nexport const PROTOCOL = 1;\n")
    (ts / "package.json").write_text('{"type":"module","private":true}\n')
    (ts / "tsconfig.json").write_text(json.dumps({"compilerOptions": {
        "target": "ES2022", "module": "NodeNext", "strict": True, "noEmit": True,
        "skipLibCheck": True, "types": [], "lib": ["ES2022"]}, "files": ["model.ts", "contract.ts"]}))
    # Native Node type stripping supplies an oracle independent of the measured bundler.
    oracle = work / "oracle"
    oracle.mkdir()
    (oracle / "package.json").write_text('{"type":"module","private":true}\n')
    (oracle / "cases.json").write_text(json.dumps(corpus(), ensure_ascii=False))
    (oracle / "main.mjs").write_text('import { readFileSync } from "node:fs";\n'
        'import { parseCodexModelCatalog } from "./model.ts";\n'
        'console.log(JSON.stringify(JSON.parse(readFileSync(new URL("./cases.json", import.meta.url))).map(value => {\n'
        'try { return { catalog: parseCodexModelCatalog(value, 123) }; } catch { return { error: "empty_catalog" }; }\n'
        '})));\n')
    expected = {}
    for limit in [160, 159]:
        (oracle / "model.ts").write_text(prefix.replace("MAX_TEXT_UNITS = 160", f"MAX_TEXT_UNITS = {limit}"))
        expected[limit] = json.loads(subprocess.check_output([node, str(oracle / "main.mjs")]))
    first = expected[160][0]["catalog"]
    assert first["models"][0]["value"] == "default" and len(first["models"]) == 9
    assert first["models"][0]["efforts"] == first["models"][1]["efforts"]
    assert "synthetic-discarded-field" not in json.dumps(expected)
    assert len(expected[160][14]["catalog"]["models"]) == 129
    assert len(expected[160][14]["catalog"]["models"][1]["efforts"]) == 65
    return expected


class Server:
    def __init__(self, argv, env, directory):
        self.directory = Path(tempfile.mkdtemp(prefix="ipc-", dir=directory))
        self.path = self.directory / "s"
        self.error = (self.directory / "stderr.log").open("wb")
        start = time.perf_counter()
        runtime_env = dict(env)
        runtime_env.pop("GOMAXPROCS", None)  # Compiler parallelism is not a runtime CPU cap.
        self.process = subprocess.Popen([*argv, str(self.path)], env=runtime_env, stdout=subprocess.PIPE, stderr=self.error)
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(self.process.stdout, selectors.EVENT_READ)
                if not selector.select(20) or self.process.stdout.readline() != b"ready\n":
                    raise RuntimeError(f"Server failed to become ready; inspect {self.directory}")
            self.startup_ms = (time.perf_counter() - start) * 1000
        except BaseException:
            self.close()
            raise

    def connect(self):
        conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        conn.settimeout(10)
        conn.connect(str(self.path))
        return conn.makefile("rwb"), conn

    def stats(self):
        fields = Path(f"/proc/{self.process.pid}/stat").read_text().split(")", 1)[1].split()
        status = dict(line.split(":", 1) for line in Path(f"/proc/{self.process.pid}/status").read_text().splitlines())
        return {"cpuMs": (int(fields[11]) + int(fields[12])) * 1000 / os.sysconf("SC_CLK_TCK"),
                "rssKiB": int(status["VmRSS"].split()[0]), "peakRssKiB": int(status["VmHWM"].split()[0])}

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try: self.process.wait(5)
            except subprocess.TimeoutExpired: self.process.kill(); self.process.wait(5)
        self.process.stdout.close()
        self.error.close()


def request(stream, value):
    stream.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode() + b"\n")
    stream.flush()
    line = stream.readline(2 * 1024 * 1024)
    if not line.endswith(b"\n"):
        raise RuntimeError("Incomplete IPC response")
    return json.loads(line)


def parity(argv, env, work, expected, limit, protocol):
    server = Server(argv, env, work)
    try:
        stream, conn = server.connect()
        try:
            for i, (value, want) in enumerate(zip(corpus(), expected[limit], strict=True)):
                result = request(stream, value)
                if result != {"protocol": protocol, **want}:
                    raise RuntimeError(f"Parity failed at fixture {i}: {result!r} != {want!r}")
            stream.write(b"{broken\n")
            stream.flush()
            assert json.loads(stream.readline()) == {"protocol": protocol, "error": "invalid_json"}
            # Malformed input must not poison the next request on this connection.
            assert request(stream, corpus()[0]) == {"protocol": protocol, **expected[limit][0]}
        finally: stream.close(); conn.close()
        return len(corpus()) + 2
    finally: server.close()


def runtime(argv, env, work, expected, requests, concurrency):
    server = Server(argv, env, work)
    try:
        idle = server.stats()
        value = corpus()[0]
        stream, conn = server.connect()
        start = time.perf_counter()
        assert request(stream, value) == {"protocol": 1, **expected[160][0]}
        first_ms = (time.perf_counter() - start) * 1000
        for _ in range(1000): request(stream, value)
        stream.close(); conn.close()
        before = server.stats()
        payload = json.dumps(value, separators=(",", ":")).encode() + b"\n"
        want = {"protocol": 1, **expected[160][0]}
        def client(count):
            # Buffered reads avoid one syscall per byte in Python's socket reader.
            conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            conn.settimeout(10); conn.connect(str(server.path))
            reader = conn.makefile("rb")
            samples = []
            try:
                for _ in range(count):
                    start = time.perf_counter_ns()
                    conn.sendall(payload)
                    line = reader.readline(2 * 1024 * 1024)
                    samples.append((time.perf_counter_ns() - start) / 1e6)
                    if json.loads(line) != want: raise RuntimeError("Runtime response changed")
            finally: reader.close(); conn.close()
            return samples
        client_start = time.process_time()
        started = time.perf_counter()
        with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as pool:
            groups = list(pool.map(client, [requests // concurrency] * concurrency))
        wall_ms = (time.perf_counter() - started) * 1000
        samples = sorted(x for group in groups for x in group)
        after = server.stats()
        return {"requests": len(samples), "concurrency": concurrency,
                "startupMs": server.startup_ms, "firstRequestMs": first_ms,
                "p50Ms": samples[math.ceil(len(samples) * .5) - 1],
                "p95Ms": samples[math.ceil(len(samples) * .95) - 1],
                "wallMs": wall_ms, "requestsPerSecond": len(samples) * 1000 / wall_ms,
                "serverCpuMs": after["cpuMs"] - before["cpuMs"],
                "clientCpuMs": (time.process_time() - client_start) * 1000,
                "idleRssKiB": idle["rssKiB"], "warmRssKiB": after["rssKiB"],
                "serverPeakRssKiB": after["peakRssKiB"],
                "driverPeakRssKiB": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
                "loadAfter": list(os.getloadavg())}
    finally: server.close()


def compatibility_probes(argv, env, work):
    # Keep JSON parser differences visible rather than silently restricting the
    # production contract to the well-formed-Unicode benchmark corpus.
    probes = {
        "escaped-lone-surrogate": b'{"data":[{"model":"\\ud800"}]}\n',
        "overflow-number-in-unused-metadata": b'{"data":[{"model":"visible"}],"unused":1e400}\n',
        "duplicate-object-key": b'{"data":[{"model":"first","model":"last"}]}\n',
    }
    server = Server(argv, env, work)
    try:
        stream, conn = server.connect()
        try:
            results = {}
            for name, raw in probes.items():
                stream.write(raw); stream.flush()
                results[name] = json.loads(stream.readline())
            return results
        finally: stream.close(); conn.close()
    finally: server.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--go", default="go")
    parser.add_argument("--node", default="node")
    parser.add_argument("--rounds", type=int, default=4)
    parser.add_argument("--requests", type=int, default=1000)
    parser.add_argument("--native", action="store_true", help="Also measure the existing native workspace and one-platform packaging")
    args = parser.parse_args()
    if not 1 <= args.rounds <= 10 or args.requests < 4 or args.requests % 4:
        parser.error("Use 1..10 rounds and a positive request count divisible by 4")
    if args.out.exists(): parser.error("Refusing to overwrite an existing report")
    if platform.system() != "Linux" or platform.machine() not in ["aarch64", "x86_64"]:
        parser.error("This measurement harness supports Linux ARM64 and x64")
    work = Path(tempfile.mkdtemp(prefix="palm-lang-"))
    print(f"Private logs and disposable sources: {work}", flush=True)
    env = dict(os.environ, CARGO_BUILD_JOBS="2", GOMAXPROCS="2", CGO_ENABLED="0", GOTOOLCHAIN="local")
    # Avoid inherited build flags/wrappers silently changing this comparison.
    for key in ["RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER", "CARGO_INCREMENTAL", "GOFLAGS", "GOCACHEPROG"]:
        env.pop(key, None)
    node = shutil.which(args.node)
    go = shutil.which(args.go)
    if not node or not go: parser.error("Node and Go must be installed before running")
    node_version = subprocess.check_output([node, "--version"], text=True).strip()
    if node_version != "v" + (ROOT / ".nvmrc").read_text().strip(): parser.error("Use the repository's exact Node version")
    env["PATH"] = str(Path(node).parent) + os.pathsep + env["PATH"]
    expected = prepare(work, node)
    variants = ["ts", "go", "rust-dev", "rust-release"]
    envs = {v: dict(env, CARGO_TARGET_DIR=str(work / v / "target"), GOCACHE=str(work / "go-cache")) for v in variants}
    (work / "go-cache").mkdir()
    report = {"schemaVersion": 1, "sourceCommit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
              "parserSha256": digest(PARSER), "typesSha256": digest(TYPES),
              "context": {"os": "linux", "arch": platform.machine(), "logicalCpus": os.cpu_count(),
                          "compilerJobs": 2, "goCompilerMaxProcs": 2, "goRuntimeMaxProcs": "default", "node": node_version,
                          "go": subprocess.check_output([go, "version"], text=True).strip(),
                          "rust": subprocess.check_output(["rustc", "--version"], cwd=ROOT, text=True).strip(),
                          "rounds": args.rounds, "fixtureCount": len(corpus()), "fixtureSeed": 240},
              "builds": [], "runtime": [], "native": [], "independence": []}
    report["harnessHashes"] = {str(path.relative_to(HERE)): digest(path) for path in sorted(HERE.rglob("*"))
                                if path.is_file() and "__pycache__" not in path.parts and "target" not in path.parts}
    def save():
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(report, indent=2) + "\n")
    def build(v, scenario, round_number):
        folder = work / v
        log = work / f"{v}-{scenario}-{round_number}.log"
        if v == "ts":
            stages = [command([node, str(ROOT / "node_modules/typescript/bin/tsc"), "-p", str(folder)], folder, envs[v], log),
                      command([node, str(HERE / "build-ts.mjs"), str(folder)], ROOT, envs[v], log.with_suffix(".bundle.log"))]
            timing = {"wallMs": sum(s["wallMs"] for s in stages), "cpuMs": sum(s["cpuMs"] for s in stages), "stages": stages}
        elif v == "go":
            timing = command([go, "build", "-p", "2", "-trimpath", "-o", "server", "."], folder, envs[v], log)
        else:
            timing = command(["cargo", "build", "--locked", "--offline", "--timings", *(["--release"] if v.endswith("release") else [])], folder, envs[v], log)
        report["builds"].append({"variant": v, "scenario": scenario, "round": round_number, **timing})
        save()
        print(f"{v} {scenario}: {timing['wallMs']:.1f} ms", flush=True)
    def argv(v):
        if v == "ts": return [node, str(work / v / "server.bundle.mjs")]
        if v == "go": return [str(work / v / "server")]
        return [str(work / v / "target" / ("release" if v.endswith("release") else "debug") / "catalog-experiment")]
    def check(v, limit, protocol):
        start = time.perf_counter()
        count = parity(argv(v), envs[v], work, expected, limit, protocol)
        elapsed = (time.perf_counter() - start) * 1000
        report["builds"][-1]["parityMs"] = elapsed
        report["builds"][-1]["buildAndParityMs"] = report["builds"][-1]["wallMs"] + elapsed
        return count
    # Downloads are outside measured cold builds. Rust's sysroot is precompiled;
    # an empty Go build cache also compiles standard-library packages.
    for v in ["rust-dev", "rust-release"]:
        command(["cargo", "fetch", "--locked"], work / v, envs[v], work / f"{v}-fetch.log")
    for v in variants:
        build(v, "cold", 0)
        report.setdefault("parity", {})[v] = check(v, 160, 1)
    limits = {v: 160 for v in variants}; protocols = {v: 1 for v in variants}
    edit_files = {"ts": ("model.ts", "MAX_TEXT_UNITS = "), "go": ("model/model.go", "MaxTextUnits = "),
                  "rust-dev": ("src/model.rs", "MAX_TEXT_UNITS: usize = "), "rust-release": ("src/model.rs", "MAX_TEXT_UNITS: usize = ")}
    contract_files = {"ts": ("contract.ts", "PROTOCOL = "), "go": ("contract/contract.go", "Protocol = "),
                      "rust-dev": ("contract/src/lib.rs", "PROTOCOL: u8 = "), "rust-release": ("contract/src/lib.rs", "PROTOCOL: u8 = ")}
    for round_number in range(args.rounds):
        order = variants[round_number % 4:] + variants[:round_number % 4]
        for scenario in ["no-change", "logic-edit", "contract-value-edit"]:
            for v in order:
                binary = Path(argv("rust-release")[0])
                before_rust = (digest(binary), binary.stat().st_mtime_ns)
                if scenario != "no-change":
                    files, states, total = (edit_files, limits, 319) if scenario == "logic-edit" else (contract_files, protocols, 3)
                    relative, anchor = files[v]
                    new = total - states[v]
                    replace_once(work / v / relative, anchor + str(states[v]), anchor + str(new))
                    states[v] = new
                build(v, scenario, round_number)
                report["parity"][v] += check(v, limits[v], protocols[v])
                if v == "go":
                    unchanged = before_rust == (digest(binary), binary.stat().st_mtime_ns)
                    if not unchanged: raise RuntimeError("Go build changed the Rust artifact")
                    report["independence"].append({"round": round_number, "scenario": scenario, "rustArtifactUnchanged": unchanged})
    # Restore the same baseline before runtime comparisons; do not compare modified policies.
    for v in variants:
        for files, states, baseline in [(edit_files, limits, 160), (contract_files, protocols, 1)]:
            relative, anchor = files[v]
            if states[v] != baseline: replace_once(work / v / relative, anchor + str(states[v]), anchor + str(baseline))
        build(v, "restore", 0)
        report["parity"][v] += check(v, 160, 1)
    probes = {v: compatibility_probes(argv(v), envs[v], work) for v in variants}
    report["compatibilityProbes"] = {v: {name: {"matchesTypeScript": result == probes["ts"][name], "response": result}
                                         for name, result in results.items()} for v, results in probes.items()}
    for round_number in range(args.rounds):
        order = variants[round_number % 4:] + variants[:round_number % 4]
        for v in order:
            for concurrency in [1, 4]:
                result = runtime(argv(v), envs[v], work, expected, args.requests, concurrency)
                report["runtime"].append({"variant": v, "round": round_number, **result})
                save()
                print(f"{v} IPC c={concurrency}: p50={result['p50Ms']:.3f} ms; RSS={result['warmRssKiB']} KiB", flush=True)
    if args.native:
        native_measurements(work, env, node, report, args.rounds, save)
    report["complete"] = True
    save()
    print(f"Completed. Aggregate report: {args.out}", flush=True)


def native_measurements(work, env, node, report, rounds, save):
    folder = work / "native"
    folder.mkdir()
    for name in ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "package.json", "scripts/build-daemon.mjs",
                 "scripts/lib/native-toolchain.mjs", "packages/shared/src/telemetry-contract.json"]:
        target = folder / name; target.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(ROOT / name, target)
    for name in ["apps/palmagentd", "apps/palmagent-runtime", "packages/native-telemetry"]:
        shutil.copytree(ROOT / name, folder / name, ignore=shutil.ignore_patterns("target", "node_modules"))
    native_env = dict(env, PALMAGENT_NATIVE_PLATFORM="linux-arm64" if platform.machine() == "aarch64" else "linux-x64",
                      CARGO_TARGET_DIR=str(folder / "target"),
                      GIT_AUTHOR_NAME="Benchmark Fixture", GIT_AUTHOR_EMAIL="benchmark@example.invalid",
                      GIT_COMMITTER_NAME="Benchmark Fixture", GIT_COMMITTER_EMAIL="benchmark@example.invalid")
    def setup(argv, name): command(argv, folder, native_env, work / f"native-{name}.log")
    setup(["git", "init", "--quiet"], "init")
    (folder / ".gitignore").write_text("target/\nbuild/\n")
    setup(["git", "add", "."], "add")
    setup(["git", "-c", "commit.gpgsign=false", "commit", "-qm", "Synthetic benchmark snapshot"], "commit")
    setup(["cargo", "fetch", "--locked"], "fetch")
    # Download/verify the pinned C toolchain before any timed package build.
    setup([node, "--input-type=module", "-e", 'import { sqliteToolchain } from "./scripts/lib/native-toolchain.mjs"; const t = await sqliteToolchain(process.cwd()); t.close();'], "toolchain")
    source = folder / "apps/palmagent-runtime/src/modules/routines/application.rs"
    original = source.read_text()
    if original.count('"Invalid script routine input"') != 1: raise RuntimeError("Native edit anchor changed")
    for mode in ["dev", "package-release"]:
        argv = ["cargo", "build", "--workspace", "--locked", "--offline", "--timings"] if mode == "dev" else [node, "scripts/build-daemon.mjs"]
        def measure(scenario, round_number):
            timing = command(argv, folder, native_env, work / f"native-{mode}-{scenario}-{round_number}.log")
            report["native"].append({"mode": mode, "scenario": scenario, "round": round_number, **timing})
            save(); print(f"native {mode} {scenario}: {timing['wallMs']:.1f} ms", flush=True)
        measure("cold", 0)
        for i in range(rounds):
            measure("no-change", i)
            source.write_text(original.replace('"Invalid script routine input"', f'"Invalid script routine input {i}"'))
            measure("logic-edit", i)
            # A new commit with identical files isolates source-identity invalidation.
            setup(["git", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", f"Fixture identity {mode} {i}"], f"identity-{mode}-{i}")
            measure("identity-only", i)
        source.write_text(original)
    report["nativeArtifactHashes"] = {path.name + "/" + binary.name: digest(binary)
        for path in (folder / "build/daemon").iterdir() if path.is_dir() for binary in path.iterdir() if binary.is_file()}


if __name__ == "__main__":
    main()
