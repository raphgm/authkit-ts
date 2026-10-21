// Minimal Prometheus text-format counters, so the gateway can be scraped
// without pulling in a metrics library.
export class Metrics {
  private counters = new Map<string, number>();

  inc(name: string, labels: Record<string, string> = {}): void {
    const key = name + formatLabels(labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  render(): string {
    const lines = [...this.counters].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k} ${v}`);
    return lines.join('\n') + '\n';
  }
}

function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  return '{' + entries.map(([k, v]) => `${k}="${v.replace(/["\\\n]/g, '_')}"`).join(',') + '}';
}
