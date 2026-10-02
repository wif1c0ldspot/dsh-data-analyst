#!/usr/bin/env node
import { runGoldenEval } from '../dist/nl-eval.js'

const report = await runGoldenEval()
console.log(JSON.stringify(report, null, 2))
process.exit(report.failed === 0 ? 0 : 1)
