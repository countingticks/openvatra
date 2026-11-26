import { resolve } from 'path'
import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter'
import { formatReport } from './format'
import type { ScenarioResult } from './result'

/** Collects each scenario's `perf-result` attachment and prints one table when the run ends. */
export default class PerfReporter implements Reporter {
  private results: ScenarioResult[] = []
  private skipped: { scenario: string; reason: string }[] = []

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status === 'skipped') {
      const skip = test.annotations.find((a) => a.type === 'skip')
      this.skipped.push({ scenario: test.title, reason: skip?.description ?? 'skipped' })
      return
    }
    const attachment = result.attachments.find((a) => a.name === 'perf-result')
    if (result.status === 'passed' && attachment?.body) {
      this.results.push(JSON.parse(attachment.body.toString('utf8')) as ScenarioResult)
    }
  }

  onEnd(): void {
    if (this.results.length === 0 && this.skipped.length === 0) return
    process.stdout.write(`\n${formatReport(this.results, this.skipped)}\n`)
    process.stdout.write(`full results: ${resolve('test-results', 'perf')}\n`)
  }
}
