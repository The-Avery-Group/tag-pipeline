Run npm run deploy

> tag-pipeline-api@1.0.0 deploy
> wrangler deploy


 ⛅️ wrangler 3.114.17 (update available 4.111.0)
------------------------------------------------

▲ [WARNING] The version of Wrangler you are using is now out-of-date.

  Please update to the latest version to prevent critical errors.
  Run `npm install --save-dev wrangler@4` to update to the latest version.
  After installation, run Wrangler with `npx wrangler`.


▲ [WARNING] Processing wrangler.toml configuration:

    - Unexpected fields found in observability field: "traces"



✘ [ERROR] Build failed with 3 errors:

  ✘ [ERROR] The symbol "cacheKey" has already been declared
  
      src/handlers/awards.js:563:8:
        563 │   const cacheKey = `awards_lookup:v7:${piid}:${awardeeUEI || ''}`
            ╵         ~~~~~~~~
  
    The symbol "cacheKey" was originally declared here:
  
      src/handlers/awards.js:562:8:
        562 │   const cacheKey = `awards_lookup:v6:${piid || ''}:${solicitation...
            ╵         ~~~~~~~~
  
  
  ✘ [ERROR] The symbol "records" has already been declared
  
      src/handlers/awards.js:602:8:
        602 │     let records = dedupeRecords((await fetchAwards(env, { piid })...
            ╵         ~~~~~~~
  
    The symbol "records" was originally declared here:
  
      src/handlers/awards.js:601:8:
        601 │     let records = dedupeRecords((await Promise.all(calls)).flat())
            ╵         ~~~~~~~
  
  
  ✘ [ERROR] The symbol "families" has already been declared
  
      src/handlers/awards.js:622:10:
        622 │     const families = awardeeUEI
            ╵           ~~~~~~~~
  
    The symbol "families" was originally declared here:
  
      src/handlers/awards.js:615:10:
        615 │     const families = groupByAwardFamily(records)
            ╵           ~~~~~~~~
  
  



Cloudflare collects anonymous telemetry about your usage of Wrangler. Learn more at https://github.com/cloudflare/workers-sdk/tree/main/packages/wrangler/telemetry.md
🪵  Logs were written to "/home/runner/.config/.wrangler/logs/wrangler-2026-07-16_23-20-35_981.log"
Error: Process completed with exit code 1.
