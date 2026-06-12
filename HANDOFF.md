**Subject: Handoff: Completing the BWB-MCP-SERVER Update**

This document outlines the remaining steps to complete the performance update for the `BWB-MCP-SERVER`.

The following files in the `bwb-code-assistant` project have already been patched as requested:

*   `engine/urban-myth-engine.js`
*   `engine/token-router.js`

**Remaining Tasks:**

The following tasks need to be completed in your terminal to patch the Cloudflare Worker and deploy the changes.

**1. Navigate to the Worker Project Directory:**

```bash
cd ~/projects/BWB-MCP-SERVER
```

**2. Patch `src/index.ts`:**

Apply the following `sed` commands to update the prompt constants and token limits:

```bash
sed -i 's/const SYS_NARRATIVE = .*/const SYS_NARRATIVE  = "Urban myth engine. Input: seed. Output: 100-word street-level myth, second person present tense, end mid-thought. No fantasy. No heroes.";/' src/index.ts
sed -i 's/const SYS_DISTORTION = .*/const SYS_DISTORTION = "Input: myth. Output: same myth with one impossible-but-inevitable detail injected. No explanation. No resolution. 100 words max.";/' src/index.ts
sed -i 's/const SYS_ARCHETYPE = .*/const SYS_ARCHETYPE  = "Input: myth. Output: JSON array only, 1-3 archetype names. Example: [\\\"The Corner\\\",\\\"The Signal\\"]";/' src/index.ts
sed -i 's/maxTokens = 400/maxTokens = 200/' src/index.ts
```

**3. Update `wrangler.toml`:**

Ensure the compatibility date is set correctly:

```bash
sed -i 's/compatibility_date = "2024-09-23"/compatibility_date = "2024-09-23"/' wrangler.toml
```

**4. Deploy the Worker:**

Commit and push the changes to your Git repository to deploy the updated Worker:

```bash
git add -A && git commit -m "perf: compress prompts, cap tokens to 200, tighten archetype context" && git push origin main
```

Once these steps are completed, the performance optimizations will be fully deployed.
