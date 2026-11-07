// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Copyright (C) 2026 世纪之城（广州）信息科技有限公司 (SJI)

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

console.error("execPath =", process.execPath);
const pkg = join(dirname(process.execPath), "node_modules", "onnxruntime-node");
console.error("pkg 存在 =", existsSync(pkg), pkg);
const req = createRequire(join(pkg, "package.json"));
console.error("createRequire ok, main =", req("./package.json").main);
const ort = req("./dist/index.js") as typeof import("onnxruntime-node");
console.error("ort 加载 ok, keys =", Object.keys(ort).slice(0, 4));

const dir = join(homedir(), ".xiaobenben", "models", "bge-small-zh-v1.5-int8");
const t0 = Date.now();
const session = await ort.InferenceSession.create(join(dir, "model_quantized.onnx"), { executionProviders: ["cpu"], graphOptimizationLevel: "all" });
console.log(`session 加载 ${Date.now() - t0}ms, outputs=${session.outputNames}`);
const ids = [101n, 872n, 1962n, 102n];
const n = ids.length;
const feeds = {
  input_ids: new ort.Tensor("int64", BigInt64Array.from(ids), [1, n]),
  attention_mask: new ort.Tensor("int64", BigInt64Array.from(Array.from({ length: n }, () => 1n)), [1, n]),
  token_type_ids: new ort.Tensor("int64", BigInt64Array.from(Array.from({ length: n }, () => 0n)), [1, n]),
};
const t1 = Date.now();
const out = await session.run(feeds);
console.log(`推理 ${Date.now() - t1}ms, dims=${out[session.outputNames[0]!]!.dims}`);
console.log("COMPILE+SIDECAR OK");
