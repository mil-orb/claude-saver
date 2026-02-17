---
disable-model-invocation: false
---

# /claudesaver:benchmark

Run a side-by-side comparison of local vs cloud model performance on sample tasks.

**Note:** This is a placeholder for future implementation. The benchmark will:
1. Run a set of standard tasks (docstring, commit message, test scaffold, format conversion)
2. Send each to both the local Ollama model and the cloud API
3. Compare quality, speed, and token cost
4. Help users choose the right delegation level for their hardware

For now, inform the user that benchmarking is coming in a future release. They can test manually using `claudesaver_complete` with different prompts.
