import * as assert from 'node:assert/strict';
import type * as vscode from 'vscode';
import { EditController, type EditHost, type EditOps } from '../../src/edit/editController';
import type { EditError, ToWebview } from '../../src/protocol';
import { createMarkdownRenderer, type RenderResult } from '../../src/render/markdown';

const SOURCE = '# Title\n\npara\n\n- [ ] a\n- [ ] b\n- [ ] c\n';
const result: RenderResult = createMarkdownRenderer()(SOURCE, { mermaid: true });
const HEADING = { start: 0, end: 1 };
const PARA = { start: 2, end: 3 };
const TASK_LINE = 4;
const LIST = { starts: [4, 5, 6], end: 7 };
const VERSION = 7;

type Call = string;

interface Setup {
  controller: EditController;
  doc: vscode.TextDocument;
  /** Order of the host and op calls: `render`, `save`, `post:<type>`, `op:<name>`. */
  calls: Call[];
  posted: ToWebview[];
  errors: string[];
}

interface Options {
  editEnabled?: boolean;
  editSaveOnCommit?: boolean;
  /** What `liveDocument` does: resolve the document (default), resolve undefined, or reject. */
  liveDocument?: 'doc' | 'none' | 'reject';
  docVersion?: number;
  renderVersion?: number | 'none';
  isDirty?: boolean;
  isUntitled?: boolean;
  shown?: boolean;
  renderThrows?: boolean;
  saveRejects?: boolean;
  /** Results the edit ops return (or `throw`). */
  applyResult?: Awaited<ReturnType<EditOps['applyBlockEdit']>> | 'throw';
  toggleResult?: Awaited<ReturnType<EditOps['toggleTask']>> | 'throw';
  moveResult?: Awaited<ReturnType<EditOps['moveListItemEdit']>> | 'throw';
  readResult?: ReturnType<EditOps['readBlock']> | 'throw';
}

function setup(o: Options = {}): Setup {
  const calls: Call[] = [];
  const posted: ToWebview[] = [];
  const errors: string[] = [];
  const doc = {
    version: o.docVersion ?? VERSION,
    isDirty: o.isDirty ?? true,
    isUntitled: o.isUntitled ?? false,
  } as unknown as vscode.TextDocument;
  const renderVersion = o.renderVersion ?? VERSION;
  const host: EditHost = {
    settings: () => ({ editEnabled: o.editEnabled ?? true, editSaveOnCommit: o.editSaveOnCommit ?? false }),
    liveDocument: () => {
      if (o.liveDocument === 'reject') return Promise.reject(new Error('cannot reopen'));
      return Promise.resolve(o.liveDocument === 'none' ? undefined : doc);
    },
    lastRender: () => (renderVersion === 'none' ? undefined : { result, docVersion: renderVersion }),
    post: (message) => {
      calls.push(`post:${message.type}`);
      posted.push(message);
    },
    renderAfterEdit: () => {
      calls.push('render');
      return o.renderThrows ? Promise.reject(new Error('render failed')) : Promise.resolve();
    },
    isShownInEditor: () => o.shown ?? true,
    save: () => {
      calls.push('save');
      return o.saveRejects ? Promise.reject(new Error('save failed')) : Promise.resolve();
    },
    logError: (task, error) => {
      errors.push(`${task}: ${error instanceof Error ? error.message : String(error)}`);
    },
  };
  const ops: EditOps = {
    readBlock: (_d, start, end, docVersion) => {
      calls.push('op:readBlock');
      if (o.readResult === 'throw') throw new Error('read threw');
      return o.readResult ?? { text: `source ${start}-${end}@${docVersion}` };
    },
    applyBlockEdit: (): ReturnType<EditOps['applyBlockEdit']> => {
      calls.push('op:applyBlockEdit');
      if (o.applyResult === 'throw') return Promise.reject(new Error('apply threw'));
      return Promise.resolve(o.applyResult ?? { ok: true });
    },
    toggleTask: (): ReturnType<EditOps['toggleTask']> => {
      calls.push('op:toggleTask');
      if (o.toggleResult === 'throw') return Promise.reject(new Error('toggle threw'));
      return Promise.resolve(o.toggleResult ?? { ok: true });
    },
    moveListItemEdit: (): ReturnType<EditOps['moveListItemEdit']> => {
      calls.push('op:moveListItemEdit');
      if (o.moveResult === 'throw') return Promise.reject(new Error('move threw'));
      return Promise.resolve(o.moveResult ?? { ok: true, line: 5 });
    },
  };
  return { controller: new EditController(host, ops), doc, calls, posted, errors };
}

/** The four requests, each citing a range the real render produced. */
const requests: { name: string; run: (c: EditController, version?: number) => Promise<void>; reply: string }[] = [
  { name: 'requestBlockSource', run: (c, v = VERSION) => c.sendBlockSource(PARA.start, PARA.end, v), reply: 'blockSource' },
  { name: 'editBlock', run: (c, v = VERSION) => c.editBlock(PARA.start, PARA.end, v, 'new'), reply: 'editResult' },
  { name: 'toggleTask', run: (c, v = VERSION) => c.setTaskChecked(TASK_LINE, true, v), reply: 'taskResult' },
  { name: 'moveListItem', run: (c, v = VERSION) => c.moveListItem(LIST.starts, LIST.end, 0, 2, v), reply: 'moveResult' },
];

/** The error a reply carries (every reply type has an optional `error`). */
function errorOf(message: ToWebview | undefined): EditError | undefined {
  assert.ok(message);
  return 'error' in message ? message.error : undefined;
}

function opCalls(calls: Call[]): Call[] {
  return calls.filter((c) => c.startsWith('op:'));
}

describe('EditController fixture', () => {
  it('the real render produces the ranges the tests cite', () => {
    assert.deepEqual(
      result.topBlocks.map((b) => [b.line, b.end]),
      [[0, 1], [2, 3], [4, 7]],
    );
    assert.deepEqual(result.taskLines, [4, 5, 6]);
    assert.deepEqual(result.lists, [{ starts: [4, 5, 6], end: 7 }]);
    assert.equal(HEADING.end, 1);
  });
});

describe('EditController refusals', () => {
  for (const r of requests) {
    describe(r.name, () => {
      it('replies failed when editing is disabled', async () => {
        const s = setup({ editEnabled: false });
        await r.run(s.controller);
        assert.equal(s.posted.length, 1);
        assert.equal(s.posted[0].type, r.reply);
        assert.equal(errorOf(s.posted[0]), 'failed');
        assert.deepEqual(s.calls, [`post:${r.reply}`]);
      });

      it('replies failed when the document cannot be reopened', async () => {
        const s = setup({ liveDocument: 'none' });
        await r.run(s.controller);
        assert.equal(s.posted.length, 1);
        assert.equal(errorOf(s.posted[0]), 'failed');
        assert.deepEqual(opCalls(s.calls), []);
      });

      it('replies failed, and logs, when reopening the document rejects', async () => {
        const s = setup({ liveDocument: 'reject' });
        await r.run(s.controller);
        assert.equal(s.posted.length, 1);
        assert.equal(s.posted[0].type, r.reply);
        assert.equal(errorOf(s.posted[0]), 'failed');
        assert.deepEqual(s.calls, [`post:${r.reply}`]);
        assert.deepEqual(s.errors, ['Preparing an edit: cannot reopen']);
      });

      it('replies stale when nothing has been rendered yet', async () => {
        const s = setup({ renderVersion: 'none' });
        await r.run(s.controller);
        assert.equal(errorOf(s.posted[0]), 'stale');
        assert.deepEqual(s.calls, [`post:${r.reply}`]);
      });

      it('replies stale when the last render is of another version than the one cited', async () => {
        const s = setup({ renderVersion: VERSION - 1 });
        await r.run(s.controller);
        assert.equal(s.posted.length, 1);
        assert.equal(errorOf(s.posted[0]), 'stale');
        assert.deepEqual(s.calls, [`post:${r.reply}`]);
      });

      it('replies stale when the live document is at another version than the one cited', async () => {
        const s = setup({ docVersion: VERSION + 1 });
        await r.run(s.controller);
        assert.equal(s.posted.length, 1);
        assert.equal(errorOf(s.posted[0]), 'stale');
        assert.deepEqual(s.calls, [`post:${r.reply}`]);
      });

      it('replies stale when the cited version differs from both the render and the document', async () => {
        const s = setup();
        await r.run(s.controller, VERSION - 1);
        assert.equal(errorOf(s.posted[0]), 'stale');
        assert.deepEqual(opCalls(s.calls), []);
      });
    });
  }

  it('requestBlockSource and editBlock reply invalid for a range the render did not produce', async () => {
    for (const [start, end] of [[0, 3], [2, 4], [3, 3], [1, 2], [9, 10]]) {
      const a = setup();
      await a.controller.sendBlockSource(start, end, VERSION);
      assert.equal(errorOf(a.posted[0]), 'invalid', `${start}-${end}`);
      const b = setup();
      await b.controller.editBlock(start, end, VERSION, 'x');
      assert.equal(errorOf(b.posted[0]), 'invalid', `${start}-${end}`);
      assert.deepEqual(a.calls, ['post:blockSource']);
      assert.deepEqual(b.calls, ['post:editResult']);
    }
  });

  it('toggleTask replies invalid for a line that is not a rendered task', async () => {
    for (const line of [0, 2, 3, 7, -1]) {
      const s = setup();
      await s.controller.setTaskChecked(line, true, VERSION);
      assert.equal(errorOf(s.posted[0]), 'invalid', String(line));
      assert.deepEqual(s.calls, ['post:taskResult']);
    }
  });

  it('moveListItem replies invalid for items that are not exactly one rendered list', async () => {
    for (const [starts, end] of [[[4, 5], 7], [[4, 5, 6], 6], [[5, 6, 4], 7], [[4], 5], [[], 0]] as const) {
      const s = setup();
      await s.controller.moveListItem([...starts], end, 0, 1, VERSION);
      assert.equal(errorOf(s.posted[0]), 'invalid', `${starts.join(',')}-${end}`);
      assert.deepEqual(s.calls, ['post:moveResult']);
    }
  });

  it('echoes the request ranges in the failure replies', async () => {
    const s = setup({ editEnabled: false });
    await s.controller.sendBlockSource(2, 3, 9);
    await s.controller.editBlock(2, 3, 9, 'x');
    await s.controller.setTaskChecked(4, true, 9);
    assert.deepEqual(s.posted, [
      { type: 'blockSource', start: 2, end: 3, docVersion: 9, error: 'failed' },
      { type: 'editResult', start: 2, end: 3, ok: false, error: 'failed' },
      { type: 'taskResult', line: 4, ok: false, error: 'failed' },
    ]);
  });
});

describe('EditController requestBlockSource', () => {
  it('passes the source through with start, end and docVersion', async () => {
    const s = setup();
    await s.controller.sendBlockSource(PARA.start, PARA.end, VERSION);
    assert.deepEqual(s.posted, [{ type: 'blockSource', start: 2, end: 3, docVersion: VERSION, text: 'source 2-3@7' }]);
    assert.deepEqual(s.calls, ['op:readBlock', 'post:blockSource']);
  });

  it("passes the op's own error through", async () => {
    const s = setup({ readResult: { error: 'readonly' } });
    await s.controller.sendBlockSource(PARA.start, PARA.end, VERSION);
    assert.deepEqual(s.posted, [{ type: 'blockSource', start: 2, end: 3, docVersion: VERSION, error: 'readonly' }]);
  });

  it('replies failed, and logs, when the op throws', async () => {
    const s = setup({ readResult: 'throw' });
    await s.controller.sendBlockSource(PARA.start, PARA.end, VERSION);
    assert.deepEqual(s.posted, [{ type: 'blockSource', start: 2, end: 3, docVersion: VERSION, error: 'failed' }]);
    assert.deepEqual(s.errors, ['Reading a block: read threw']);
  });

  it('does not render or save', async () => {
    const s = setup();
    await s.controller.sendBlockSource(HEADING.start, HEADING.end, VERSION);
    assert.deepEqual(s.calls, ['op:readBlock', 'post:blockSource']);
  });
});

describe('EditController success replies', () => {
  it('editBlock: renders first, then replies ok once', async () => {
    const s = setup({ shown: true });
    await s.controller.editBlock(PARA.start, PARA.end, VERSION, 'new');
    assert.deepEqual(s.calls, ['op:applyBlockEdit', 'render', 'post:editResult']);
    assert.deepEqual(s.posted, [{ type: 'editResult', start: 2, end: 3, ok: true, error: undefined }]);
  });

  it('toggleTask: renders first, then replies ok once', async () => {
    const s = setup({ shown: true });
    await s.controller.setTaskChecked(TASK_LINE, true, VERSION);
    assert.deepEqual(s.calls, ['op:toggleTask', 'render', 'post:taskResult']);
    assert.deepEqual(s.posted, [{ type: 'taskResult', line: 4, ok: true, error: undefined }]);
  });

  it('moveListItem: renders first, then replies ok with the new line once', async () => {
    const s = setup({ shown: true, moveResult: { ok: true, line: 6 } });
    await s.controller.moveListItem(LIST.starts, LIST.end, 0, 2, VERSION);
    assert.deepEqual(s.calls, ['op:moveListItemEdit', 'render', 'post:moveResult']);
    assert.deepEqual(s.posted, [{ type: 'moveResult', ok: true, line: 6 }]);
  });

  it('passes the request arguments to the ops', async () => {
    const seen: unknown[][] = [];
    const s = setup();
    // Rebuild the controller with recording ops: the fixture ops only record the call names.
    const controller = new EditController(
      {
        settings: () => ({ editEnabled: true, editSaveOnCommit: false }),
        liveDocument: () => Promise.resolve(s.doc),
        lastRender: () => ({ result, docVersion: VERSION }),
        post: () => undefined,
        renderAfterEdit: () => Promise.resolve(),
        isShownInEditor: () => true,
        save: () => Promise.resolve(),
        logError: () => undefined,
      },
      {
        readBlock: (...a) => (seen.push(['read', ...a.slice(1)]), { text: '' }),
        applyBlockEdit: (...a) => (seen.push(['apply', ...a.slice(1)]), Promise.resolve({ ok: true })),
        toggleTask: (...a) => (seen.push(['toggle', ...a.slice(1)]), Promise.resolve({ ok: true })),
        moveListItemEdit: (...a) => (seen.push(['move', ...a.slice(1)]), Promise.resolve({ ok: true, line: 0 })),
      },
    );
    await controller.sendBlockSource(2, 3, VERSION);
    await controller.editBlock(2, 3, VERSION, 'text');
    await controller.setTaskChecked(5, false, VERSION);
    await controller.moveListItem([4, 5, 6], 7, 2, 0, VERSION);
    assert.deepEqual(seen, [
      ['read', 2, 3, VERSION],
      ['apply', 2, 3, VERSION, 'text'],
      ['toggle', 5, false, VERSION],
      ['move', [4, 5, 6], 7, 2, 0, VERSION],
    ]);
  });
});

describe('EditController saving', () => {
  for (const r of requests.filter((x) => x.reply !== 'blockSource')) {
    describe(r.name, () => {
      it('saves when edit.saveOnCommit is on, after the render and before the reply', async () => {
        const s = setup({ editSaveOnCommit: true, shown: true });
        await r.run(s.controller);
        assert.deepEqual(s.calls.slice(1), ['render', 'save', `post:${r.reply}`]);
      });

      it('saves when no tab shows the document', async () => {
        const s = setup({ editSaveOnCommit: false, shown: false });
        await r.run(s.controller);
        assert.deepEqual(s.calls.slice(1), ['render', 'save', `post:${r.reply}`]);
      });

      it('does not save a document shown in a tab when saveOnCommit is off', async () => {
        const s = setup({ editSaveOnCommit: false, shown: true });
        await r.run(s.controller);
        assert.deepEqual(s.calls.slice(1), ['render', `post:${r.reply}`]);
      });

      it('does not save an untitled document', async () => {
        const s = setup({ editSaveOnCommit: true, shown: false, isUntitled: true });
        await r.run(s.controller);
        assert.deepEqual(s.calls.slice(1), ['render', `post:${r.reply}`]);
      });

      it('does not save a document that is not dirty', async () => {
        const s = setup({ editSaveOnCommit: true, shown: false, isDirty: false });
        await r.run(s.controller);
        assert.deepEqual(s.calls.slice(1), ['render', `post:${r.reply}`]);
      });
    });
  }
});

describe("EditController edit op's own failure", () => {
  const failures: EditError[] = ['readonly', 'stale', 'invalid', 'failed'];
  for (const error of failures) {
    it(`editBlock passes ${error} through without rendering or saving`, async () => {
      const s = setup({ applyResult: { ok: false, error }, shown: false });
      await s.controller.editBlock(PARA.start, PARA.end, VERSION, 'new');
      assert.deepEqual(s.calls, ['op:applyBlockEdit', 'post:editResult']);
      assert.deepEqual(s.posted, [{ type: 'editResult', start: 2, end: 3, ok: false, error }]);
    });

    it(`toggleTask passes ${error} through without rendering or saving`, async () => {
      const s = setup({ toggleResult: { ok: false, error }, shown: false });
      await s.controller.setTaskChecked(TASK_LINE, true, VERSION);
      assert.deepEqual(s.calls, ['op:toggleTask', 'post:taskResult']);
      assert.deepEqual(s.posted, [{ type: 'taskResult', line: 4, ok: false, error }]);
    });

    it(`moveListItem passes ${error} through without rendering or saving`, async () => {
      const s = setup({ moveResult: { ok: false, error }, shown: false });
      await s.controller.moveListItem(LIST.starts, LIST.end, 0, 2, VERSION);
      assert.deepEqual(s.calls, ['op:moveListItemEdit', 'post:moveResult']);
      assert.deepEqual(s.posted, [{ type: 'moveResult', ok: false, error }]);
    });
  }

  it('an op that throws is reported as failed, logged, and not rendered or saved', async () => {
    const a = setup({ applyResult: 'throw', shown: false });
    await a.controller.editBlock(PARA.start, PARA.end, VERSION, 'new');
    assert.deepEqual(a.calls, ['op:applyBlockEdit', 'post:editResult']);
    assert.deepEqual(a.posted, [{ type: 'editResult', start: 2, end: 3, ok: false, error: 'failed' }]);
    assert.deepEqual(a.errors, ['Editing a block: apply threw']);

    const t = setup({ toggleResult: 'throw', shown: false });
    await t.controller.setTaskChecked(TASK_LINE, true, VERSION);
    assert.deepEqual(t.calls, ['op:toggleTask', 'post:taskResult']);
    assert.deepEqual(t.posted, [{ type: 'taskResult', line: 4, ok: false, error: 'failed' }]);
    assert.deepEqual(t.errors, ['Toggling a task: toggle threw']);

    const m = setup({ moveResult: 'throw', shown: false });
    await m.controller.moveListItem(LIST.starts, LIST.end, 0, 2, VERSION);
    assert.deepEqual(m.calls, ['op:moveListItemEdit', 'post:moveResult']);
    assert.deepEqual(m.posted, [{ type: 'moveResult', ok: false, error: 'failed' }]);
    assert.deepEqual(m.errors, ['Moving a list item: move threw']);
  });
});

describe('EditController post-edit failures still reply once (D1)', () => {
  for (const r of requests.filter((x) => x.reply !== 'blockSource')) {
    describe(r.name, () => {
      it('replies ok once and still saves when the immediate render throws', async () => {
        const s = setup({ renderThrows: true, shown: false });
        await r.run(s.controller);
        assert.deepEqual(s.calls.slice(1), ['render', 'save', `post:${r.reply}`]);
        assert.equal(s.posted.length, 1);
        assert.equal(s.posted[0].type, r.reply);
        assert.equal(errorOf(s.posted[0]), undefined);
        assert.equal((s.posted[0] as { ok: boolean }).ok, true);
        assert.deepEqual(s.errors, ['Rendering after an edit: render failed']);
      });

      it('replies ok once when the save rejects', async () => {
        const s = setup({ saveRejects: true, shown: false });
        await r.run(s.controller);
        assert.deepEqual(s.calls.slice(1), ['render', 'save', `post:${r.reply}`]);
        assert.equal(s.posted.length, 1);
        assert.equal((s.posted[0] as { ok: boolean }).ok, true);
        assert.equal(errorOf(s.posted[0]), undefined);
        assert.deepEqual(s.errors, ['Saving after an edit: save failed']);
      });

      it('replies ok once when both the render and the save fail', async () => {
        const s = setup({ renderThrows: true, saveRejects: true, editSaveOnCommit: true });
        await r.run(s.controller);
        assert.equal(s.posted.length, 1);
        assert.equal((s.posted[0] as { ok: boolean }).ok, true);
        assert.equal(s.errors.length, 2);
      });
    });
  }

  it('moveListItem still reports the new line when the post-edit work fails', async () => {
    const s = setup({ renderThrows: true, saveRejects: true, shown: false, moveResult: { ok: true, line: 6 } });
    await s.controller.moveListItem(LIST.starts, LIST.end, 0, 2, VERSION);
    assert.deepEqual(s.posted, [{ type: 'moveResult', ok: true, line: 6 }]);
  });
});
