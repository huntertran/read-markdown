import type { FromWebview, WebviewState } from '../src/protocol';

interface VsCodeApi {
  postMessage(message: FromWebview): void;
  getState(): WebviewState | undefined;
  setState(state: WebviewState): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const api = acquireVsCodeApi();

export function post(message: FromWebview): void {
  api.postMessage(message);
}

export function getState(): WebviewState {
  return api.getState() ?? { uri: document.body.dataset.uri ?? '' };
}

export function patchState(patch: Partial<WebviewState>): void {
  api.setState({ ...getState(), uri: document.body.dataset.uri ?? '', ...patch });
}

export function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el;
}
