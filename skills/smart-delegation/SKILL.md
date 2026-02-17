---
name: smart-delegation
description: "Intelligently delegate coding tasks to local Ollama models when they don't need cloud-tier intelligence. Reduces API token usage."
when_to_use: "When a coding task is routine, repetitive, or doesn't require deep reasoning — docstrings, commit messages, boilerplate, format conversions, simple code generation, test scaffolding, file structure queries."
version: "0.1.0"
---

# Smart Delegation

You have access to Claude-Saver tools that let you offload work to local Ollama models running on the user's machine. This saves API tokens for tasks that don't need cloud intelligence.

## When to Delegate Locally

### Tier 0: No LLM Needed (use `claudesaver_fs`)
- Directory listings, file trees, file stats
- Line counts, file finding, git status/log
- Any query that needs metadata, not content

### Tier 1: Simple Local Tasks (use `claudesaver_complete`)
- Writing docstrings for functions
- Generating commit messages
- Format conversions (JSON ↔ YAML, CSV → JSON)
- Simple regex patterns
- Adding type annotations to obvious cases
- Generating boilerplate (empty test files, config templates)
- Writing TODO/FIXME comments
- Simple string manipulation tasks

### Tier 2: Moderate Local Tasks (use `claudesaver_complete` with context)
- Generating unit test scaffolding
- Writing simple CRUD endpoint code
- Creating API documentation from signatures
- Code formatting and linting suggestions
- Simple refactoring (rename variable, extract function)

## When NOT to Delegate

Keep these on the cloud API:
- Architecture decisions or complex design
- Debugging subtle or multi-file issues
- Security-sensitive code review
- Complex algorithms or data structures
- Tasks requiring understanding of large codebases
- Anything the user explicitly wants your (Claude's) opinion on

## How to Delegate

1. **Filesystem queries**: Call `claudesaver_fs` directly — zero tokens, instant results
2. **Simple tasks**: Call `claudesaver_complete` with a clear prompt
3. **File-heavy tasks**: Use the `local-worker` subagent to keep file reads out of your context

## Decision Checklist

Before each task, ask:
1. Does this need ANY LLM? → If no, use `claudesaver_fs`
2. Is this routine/repetitive? → Delegate locally
3. Does it need deep reasoning or broad context? → Keep on cloud
4. Would a wrong answer cause real problems? → Keep on cloud
