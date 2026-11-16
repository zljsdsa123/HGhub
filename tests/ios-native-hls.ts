// Test-only alias: no upstream requests or real decoder are needed to test engine selection.
const fixture = (window as unknown as { nativeMediaFixture: {
  supported: boolean;
  hls: { source: string; destroyed: boolean; loading: boolean }[];
} }).nativeMediaFixture;

export default class Hls {
  static version = "fixture";
  static Events = Object.fromEntries(["MEDIA_ATTACHED", "MANIFEST_PARSED", "FRAG_LOADING", "FRAG_LOADED", "FRAG_BUFFERED", "FRAG_LOAD_EMERGENCY_ABORTED", "ERROR", "DESTROYING"].map(name => [name, name]));
  static ErrorDetails = {};
  static ErrorTypes = {};
  static isSupported() { return fixture.supported; }
  config: Record<string, unknown>;
  levels: unknown[] = [];
  loadingEnabled = false;
  row = { source: "", destroyed: false, loading: false };
  constructor(config: Record<string, unknown>) { this.config = config; fixture.hls.push(this.row); }
  on() {}
  once() {}
  loadSource(source: string) { this.row.source = source; }
  attachMedia() {}
  startLoad() { this.loadingEnabled = true; this.row.loading = true; }
  stopLoad() { this.loadingEnabled = false; this.row.loading = false; }
  recoverMediaError() {}
  destroy() { this.row.destroyed = true; }
}
