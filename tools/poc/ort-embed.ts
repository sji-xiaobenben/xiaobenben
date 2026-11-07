/** PoC：bun + onnxruntime-node 推理验证（用本机已下载的 bge 模型） */
import { join } from "node:path";
import { homedir } from "node:os";
const dir = join(homedir(), ".xiaobenben", "models", "bge-small-zh-v1.5-int8");
const ort = await import("onnxruntime-node");
const t0 = Date.now();
const session = await ort.InferenceSession.create(join(dir, "model_quantized.onnx"), { executionProviders: ["cpu"], graphOptimizationLevel: "all" });
console.log(`session 加载 ${Date.now() - t0}ms, inputs=${session.inputNames}, outputs=${session.outputNames}`);
// 简化 tokenizer：直接用固定假 id 序列验证推理通路（真实 WordPiece 移植未做）
const ids = [101n, 872n, 1962n, 102n];
const n = ids.length;
const feeds = {
  input_ids: new ort.Tensor("int64", BigInt64Array.from(ids), [1, n]),
  attention_mask: new ort.Tensor("int64", BigInt64Array.from(Array.from({ length: n }, () => 1n)), [1, n]),
  token_type_ids: new ort.Tensor("int64", BigInt64Array.from(Array.from({ length: n }, () => 0n)), [1, n]),
};
const t1 = Date.now();
const out = await session.run(feeds);
console.log(`推理 ${Date.now() - t1}ms, output=${session.outputNames[0]}, dims=${out[session.outputNames[0]!]!.dims}`);
console.log("BUN RUN OK");
