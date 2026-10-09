# Disposable local smoke setup and evidence

These are opt-in test recipes, not automatic plugin installation. They require
explicit owner authorization, isolated test data, and existing prerequisites.
Never run against a production service. CPU inference was used; no paid/cloud
provider was configured. Paths under `/mnt/mem2` are the test machine's own
scratch volume; substitute a directory of yours.

The sections below the v0.4.0 recipe are the development record from before the
release and are kept as written. Where they say a redirect hop reached the
forbidden server once, that describes the earlier build: v0.4.0 enforces the
origin policy at an egress proxy and the same test now measures zero.

## v0.4.0 browser recipe (egress proxy)

The smoke needs the worker, its proxy module and the test, with the pinned
dependency beside them:

```
stage=/path/to/stage
cp capabilities/browser.mjs capabilities/egress.mjs "$stage/"
cp capabilities/tests/smoke-browser.mjs "$stage/tests/"
( cd "$stage" && cp /path/to/checkout/capabilities/package*.json . && npm ci --ignore-scripts )
bwrap --unshare-all --die-with-parent --new-session --cap-drop ALL \
 --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 \
 --proc /proc --dev /dev --tmpfs /tmp \
 --ro-bind /path/to/obscura-runtime /runtime --ro-bind /path/to/node /node \
 --ro-bind "$stage" /work --chdir /work \
 --clearenv --setenv PATH /node/bin:/usr/bin:/bin --setenv COBALT_BROWSER_SMOKE_ISOLATED 1 \
 --setenv OBSCURA_BINARY /runtime/obscura -- /node/bin/node tests/smoke-browser.mjs
```

`--unshare-all` gives the whole test (two fixture servers, the worker with its
proxy, and the browser) one private network namespace with loopback only. The
script starts Obscura with `--proxy` pointing at the worker's proxy port. Its
forbidden server listens on IPv4 and IPv6 loopback and counts every request and
every TCP connection; the run fails unless both stay at zero through a redirect
to another port, a redirect chain, an alternate hostname, scripted and form
navigations, direct and redirected subresources, and a browser started without
the proxy (which must be refused with `browser_egress_unverified`).

The launch that confines only the browser, for use with a worker on the host,
is in the [companion README](../README.md). From inside that
namespace, measured for the release: the forwarded proxy port connected; another
host loopback port was refused; public IPv4, public IPv6 and the link-local
metadata address were unreachable; DNS did not resolve.

# Verified disposable Hindsight smoke deployment

Owner authorized local CPU-only deployment on 2026-10-09. All resources created under `/mnt/mem2/cobalt-hindsight-smoke-20261009`; dedicated Podman storage/runroot and dedicated Ollama model directory/server. Existing Ollama services and model storage were not modified. API only published at 127.0.0.1:18888; Ollama binds 127.0.0.1:11437. Control plane disabled. No paid/cloud inference. Full image0.10.3 actually inspected size 2,946,709,581 bytes; digest sha256:5b6ef2b892703f0e82c448786349c88db60f06d8c9190432b68af00ce6dc45e3. Model qwen2.5:3b size1,929,912,432 bytes digest357c53fb659c5076de1d65ccb0b397446227b71a42be9d1603d46168015c9e4b.

Prerequisites already installed: Podman5.8.7, pasta, Ollama0.34.4. Host uses SELinux; :Z label applied only to created pgdata. Rootless `--userns keep-id` maintains operator UID access. The initial slirp4netns attempt failed because that binary is absent; no packages installed. Initial pasta mapped-address attempt couldn't reach inference and produced a correct adapter failure, preserved separately as initial-network-failure.json. Final pasta `--splice-only -T11437` forwards only loopback TCP; no general outbound browser/network route. Host downloads happened only during explicit image/model setup. CPU-only log reports library=cpu, total_vram=0.

Reproduction (requires explicit operator authorization; do not invoke by default):

```bash
mkdir -p /mnt/mem2/cobalt-hindsight-smoke-20261009/{podman,ollama-models,pgdata}
podman --root /mnt/mem2/cobalt-hindsight-smoke-20261009/podman --runroot /run/user/$(id -u)/cobalt-hindsight-smoke pull ghcr.io/vectorize-io/hindsight:0.10.3
OLLAMA_HOST=127.0.0.1:11437 OLLAMA_MODELS=/mnt/mem2/cobalt-hindsight-smoke-20261009/ollama-models OLLAMA_NO_CLOUD=1 OLLAMA_VULKAN=0 CUDA_VISIBLE_DEVICES=-1 ROCR_VISIBLE_DEVICES=-1 GGML_VK_VISIBLE_DEVICES=-1 OLLAMA_NUM_PARALLEL=1 OLLAMA_KEEP_ALIVE=5m ollama serve
# In another terminal:
OLLAMA_HOST=127.0.0.1:11437 ollama pull qwen2.5:3b
podman --root /mnt/mem2/cobalt-hindsight-smoke-20261009/podman --runroot /run/user/$(id -u)/cobalt-hindsight-smoke run -d --name cobalt-hindsight-smoke --userns keep-id \
  --network pasta:--splice-only,-T,11437 -p 127.0.0.1:18888:8888 --memory 5g --cpus 4 \
  -v /mnt/mem2/cobalt-hindsight-smoke-20261009/pgdata:/home/hindsight/.pg0:Z \
  -e HINDSIGHT_ENABLE_CP=false \
  -e HINDSIGHT_API_LLM_PROVIDER=ollama \
  -e HINDSIGHT_API_LLM_BASE_URL=http://127.0.0.1:11437/v1 \
  -e HINDSIGHT_API_LLM_MODEL=qwen2.5:3b \
  -e HINDSIGHT_API_LLM_OLLAMA_NUM_CTX=8192 \
  -e 'HINDSIGHT_API_LLM_EXTRA_BODY={"options":{"num_gpu":0,"num_thread":4,"temperature":0}}' \
  -e HINDSIGHT_API_LLM_MAX_CONCURRENT=1 -e HINDSIGHT_API_LLM_TIMEOUT=120 \
  -e HINDSIGHT_API_LLM_TRACE_ENABLED=false -e HINDSIGHT_API_AUDIT_LOG_ENABLED=false \
  -e HINDSIGHT_API_EMBEDDINGS_PROVIDER=local -e HINDSIGHT_API_RERANKER_PROVIDER=local \
  -e HF_HUB_OFFLINE=1 -e TRANSFORMERS_OFFLINE=1 ghcr.io/vectorize-io/hindsight:0.10.3
# Wait for GET http://127.0.0.1:18888/health to report status=healthy,database=connected.
PYTHONDONTWRITEBYTECODE=1 python capabilities/tests/smoke_hindsight.py http://127.0.0.1:18888
```

Exact adapter config:

```json
{
  "memory_enabled": true,
  "hindsight_endpoint": "http://127.0.0.1:18888",
  "memory_retention_consent": true,
  "memory_inference_configured": true,
  "memory_timeout_ms": 300000
}
```

First successful real result: retain72,220ms (local Qwen extraction), list1 finding8ms, recall1 finding103ms, scoped forget19ms, list0 after forget5ms; missing-service unavailable2ms followed by recovery ready1ms. Returned provenance source_commit/source_dirty/run/timestamp/verification_reference survived extraction, freshness recent_reference, confidence not_assessed, relevance_scores separate. Source was a disposable fixture, not real project secrets or transcripts. Second finalized script additionally verifies the synthetic stale-lock readiness fact before admission. Final evidence.json records its result. Reflection implemented/mocked but not part of this real smoke.

Finalized second real run PASSED: retain30,478ms (CPU prompt cache), list3 extracted facts6ms, recall3 extracted facts65ms, missing service unavailable4ms, recovery2ms, scoped document deletion11ms, list0 after deletion5ms. Assertions verified actual synthetic stale-lock failure/recovery before the summary was admitted. Source commit refers to the disposable fixture repository.

Hindsight itself runs embedded PostgreSQL, worker polling, graph maintenance and consolidation. The companion does not install/start/poll it. Deletion test observed pending consolidation finish with 0 source facts after deletion. Upstream background inference must be disclosed and configured independently; no memory jobs are added by Cockpit.

Cleanup only created resources: graceful `podman stop --time30` then remove exact smoke container and exact image in separate storage, stop only recorded isolated Ollama PID. Remove only created model/pgdata/podman paths. Preserve evidence.json, initial-network-failure.json and small logs/resource manifest for audit. No shared model/store pruning.

## Obscura verified isolation recipe

Repro (requires already downloaded verified runtime and npm dependency, Linux bubblewrap):
```
cp capabilities/browser.mjs /mnt/mem2/cobalt-obscura-smoke-20261009/companion/browser.mjs
cp capabilities/tests/smoke-browser.mjs /mnt/mem2/cobalt-obscura-smoke-20261009/companion/tests/smoke-browser.mjs
bwrap --unshare-all --die-with-parent --new-session --cap-drop ALL \
 --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 \
 --proc /proc --dev /dev --tmpfs /tmp \
 --ro-bind /mnt/mem2/cobalt-obscura-smoke-20261009/runtime /runtime \
 --ro-bind /mnt/mem2/cobalt-obscura-smoke-20261009/companion /work --chdir /work \
 --clearenv --setenv PATH /usr/bin:/bin --setenv COBALT_BROWSER_SMOKE_ISOLATED 1 \
 --setenv OBSCURA_BINARY /runtime/obscura -- /runtime/node tests/smoke-browser.mjs
```


Obscura smoke passed three times (including the main integrator rerun), with
9,046-byte renderer PNG evidence, actual JS/DOM, console error, network200,
foreign-origin block (destination server0hits), metadata refusal, fresh-context
localStorage, granted button click, timeout and recovery. Processes stopped;
screenshots were ephemeral and not persisted. The test-created runtime/dependencies/cache (~386MiB) were removed after
verification; downloading the pinned verified archive and installing the
optional dependency again are prerequisites for replay. The isolated host
bootstrap configuration was also removed.

Second hardened reruns (2026-10-09, after the independent review):

Hindsight rerun (`evidence/hindsight-smoke-2.json`, exit 0): status ready 4 ms;
retain 46,040 ms with `verification_status: verified` and outcome confirmed;
list 6 ms; recall with real reranker/semantic/keyword scores; reflect
175,435 ms returning real generated text (`reflection_real_tested: true`);
scoped forget 16 ms; list 0 after deletion; missing service unavailable 2 ms
and real recovery ready 1 ms. Non-inference observations carried the new 30 s
cap; reflection used the full configured budget.

Obscura rerun, same bubblewrap recipe with the node runtime bound read-only:

```
--ro-bind <node-runtime-directory> /node \
--setenv PATH /node/bin:/usr/bin:/bin
```

Checks (`evidence/browser-smoke-2.json`): real JS/DOM, 9,736-byte PNG,
console.error, network200, blocked foreign page request (target 0 hits),
metadata refusal, fresh-context localStorage, unauthorized action refused,
approved click, unauthorized fill refused, fill value mismatch refused,
approved fill mutating the real DOM, readonly and hidden fill refusal, a
redirect off the allowlist refused after landing (`redirect_hop_hits: 1`),
timeout not verified, fresh recovery. The redirect hop itself reached the
non-allowlisted target once before refusal: that is a documented residual, and
the operator's OS/egress isolation remains the containment. No screenshot was
persisted.

Obscura release archive SHA-256:
`757e7b597ba5cdd53af9fc701e0a9b80f0a8d788f545d4f82ec9ad32db77f000`.
This recipe confines the browser to a fresh network namespace with only its
local fixtures, read-only runtime/worker mounts, tmpfs, cleared environment and
no host secrets. The upstream broad private-network flag is used only inside
that namespace. Public-network sandbox deployments need their own exact
egress controls; this test does not certify them.
