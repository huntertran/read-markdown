import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { QUICK_SETTING_KEYS } from '../../src/protocol';
import {
  DEFAULTS,
  ENUM_SETTINGS,
  NUMBER_SETTINGS,
  boolOr,
  clampNumber,
  headingMapOf,
  isWithinLimits,
  oneOf,
  readBool,
  readEnum,
  readNumber,
  readString,
  stringArrayOr,
  stringOr,
  validateQuickSetting,
  type EnumSettingKey,
  type NumberSettingKey,
} from '../../src/config/values';

interface Declared {
  type?: string;
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
}

const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
  contributes: { configuration: { properties: Record<string, Declared> } };
};
const declared = new Map(Object.entries(pkg.contributes.configuration.properties).map(([k, v]) => [k.replace(/^readMarkdown\./, ''), v]));

const keys = <T extends object>(o: T) => Object.keys(o) as (keyof T & string)[];
const BAD = [undefined, null, NaN, Infinity, -Infinity, '3', 'abc', '', {}, [], true, false];

describe('oneOf', () => {
  const allowed = ['a', 'b'] as const;
  it('keeps a listed value', () => assert.equal(oneOf('b', allowed, 'a'), 'b'));
  it('falls back for an unlisted string, other types and a missing value', () => {
    for (const v of ['c', 'A', '', 1, null, undefined, {}, ['a']]) assert.equal(oneOf(v, allowed, 'a'), 'a');
  });
});

describe('clampNumber', () => {
  const lim = { min: 1, max: 6 };
  it('keeps a value in range, including both bounds', () => {
    for (const v of [1, 3.5, 6]) assert.equal(clampNumber(v, lim, 3), v);
  });
  it('pulls an out-of-range value to the nearest bound', () => {
    assert.equal(clampNumber(0, lim, 3), 1);
    assert.equal(clampNumber(-100, lim, 3), 1);
    assert.equal(clampNumber(7, lim, 3), 6);
  });
  it('falls back for NaN, Infinity, numeric strings and other types', () => {
    for (const v of [NaN, Infinity, -Infinity, '5', '', null, undefined, true, {}, [4]]) assert.equal(clampNumber(v, lim, 3), 3);
  });
  it('rounds before clamping when the limits ask for whole numbers', () => {
    const whole = { min: 1, max: 6, integer: true };
    assert.equal(clampNumber(2.4, whole, 3), 2);
    assert.equal(clampNumber(2.5, whole, 3), 3);
    assert.equal(clampNumber(6.4, whole, 3), 6);
    assert.equal(clampNumber(0.4, whole, 3), 1);
    assert.equal(clampNumber(2.5, lim, 3), 2.5);
  });
});

describe('isWithinLimits', () => {
  it('accepts finite in-range numbers only', () => {
    assert.equal(isWithinLimits(1, { min: 1, max: 6 }), true);
    assert.equal(isWithinLimits(0.99, { min: 1, max: 6 }), false);
    assert.equal(isWithinLimits(6.01, { min: 1, max: 6 }), false);
    for (const v of [NaN, Infinity, '3', null, undefined]) assert.equal(isWithinLimits(v, { min: 1, max: 6 }), false);
  });
  it('requires a whole number when asked', () => {
    assert.equal(isWithinLimits(2.5, { min: 1, max: 6, integer: true }), false);
    assert.equal(isWithinLimits(2, { min: 1, max: 6, integer: true }), true);
  });
});

describe('boolOr / stringOr', () => {
  it('keep a value of the right type', () => {
    assert.equal(boolOr(false, true), false);
    assert.equal(stringOr('', 'x'), '');
    assert.equal(stringOr('#fff', ''), '#fff');
  });
  it('fall back for any other type and a missing value', () => {
    for (const v of [undefined, null, 0, 1, 'true', 'false', {}, []]) assert.equal(boolOr(v, true), true);
    for (const v of [undefined, null, 0, true, {}, ['a']]) assert.equal(stringOr(v, 'x'), 'x');
  });
});

describe('stringArrayOr', () => {
  it('keeps the strings of an array and drops other entries', () => {
    assert.deepEqual(stringArrayOr(['a.css', 'b.css'], []), ['a.css', 'b.css']);
    assert.deepEqual(stringArrayOr(['a.css', 1, null, {}, 'b.css'], []), ['a.css', 'b.css']);
  });
  it('falls back to a copy of the default for a non-array', () => {
    const fallback = ['d'];
    for (const v of [undefined, null, 'a.css', 3, {}]) {
      const out = stringArrayOr(v, fallback);
      assert.deepEqual(out, ['d']);
      assert.notEqual(out, fallback);
    }
  });
});

describe('headingMapOf', () => {
  it('keeps string values of h1..h6', () => {
    assert.deepEqual(headingMapOf({ h1: '2em', h6: 'red' }), { h1: '2em', h6: 'red' });
  });
  it('drops other keys and non-string values', () => {
    assert.deepEqual(headingMapOf({ h1: 2, h2: null, h3: '1em', h7: '1em', other: 'x' }), { h3: '1em' });
  });
  it('gives an empty map for a non-object', () => {
    for (const v of [undefined, null, 'h1', 3, [], ['h1']]) assert.deepEqual(headingMapOf(v), {});
  });
});

describe('typed readers', () => {
  it('readEnum accepts every listed value and falls back to the default otherwise', () => {
    for (const key of keys(ENUM_SETTINGS)) {
      for (const v of ENUM_SETTINGS[key]) assert.equal(readEnum(key, v), v, `${key}=${v}`);
      for (const v of [...BAD, 'nonsense']) assert.equal(readEnum(key, v), DEFAULTS[key], `${key}=${inspect(v)}`);
    }
  });
  it('readNumber keeps in-range values, clamps out-of-range ones, and defaults for non-numbers', () => {
    for (const key of keys(NUMBER_SETTINGS)) {
      const { min, max } = NUMBER_SETTINGS[key];
      assert.equal(readNumber(key, min), min, key);
      assert.equal(readNumber(key, max), max, key);
      assert.equal(readNumber(key, min - 1000), min, key);
      assert.equal(readNumber(key, max + 1000), max, key);
      for (const v of [undefined, null, NaN, Infinity, -Infinity, String(min), 'abc', {}, [], true]) {
        assert.equal(readNumber(key, v), DEFAULTS[key], `${key}=${inspect(v)}`);
      }
    }
  });
  it('readBool and readString use the default for a value of the wrong type', () => {
    assert.equal(readBool('nav.show', 'yes'), true);
    assert.equal(readBool('edit.enabled', 1), false);
    assert.equal(readBool('edit.enabled', true), true);
    assert.equal(readString('body.fontFamily', 12), '');
    assert.equal(readString('body.fontFamily', 'Georgia'), 'Georgia');
  });
});

describe('settings vs package.json', () => {
  it('has a default for exactly the declared settings, replaceDefault aside (it is only read by `when` clauses)', () => {
    const readByCode = [...declared.keys()].filter((k) => k !== 'preview.replaceDefault').sort();
    assert.deepEqual(Object.keys(DEFAULTS).sort(), readByCode);
  });

  it('every default equals the package.json default', () => {
    for (const key of keys(DEFAULTS)) assert.deepEqual(DEFAULTS[key], declared.get(key)?.default, key);
  });

  it('every enum list equals the package.json enum, in order', () => {
    for (const key of keys(ENUM_SETTINGS)) assert.deepEqual([...ENUM_SETTINGS[key]], declared.get(key)?.enum, key);
  });

  it('every package.json string enum has a list in the code', () => {
    const declaredEnums = [...declared].filter(([, v]) => v.enum).map(([k]) => k).sort();
    assert.deepEqual(keys(ENUM_SETTINGS).sort(), declaredEnums);
  });

  it('every number bound equals the package.json one; an undeclared bound is a deliberate cap', () => {
    for (const key of keys(NUMBER_SETTINGS)) {
      const d = declared.get(key);
      const { min, max, integer } = NUMBER_SETTINGS[key] as { min: number; max: number; integer?: boolean };
      assert.equal(d?.minimum, min, `${key} minimum`);
      if (d?.maximum !== undefined) assert.equal(d.maximum, max, `${key} maximum`);
      assert.equal(d?.type, integer ? 'integer' : 'number', `${key} type`);
      assert.ok(min <= (DEFAULTS[key] as number) && (DEFAULTS[key] as number) <= max, `${key} default in range`);
    }
  });

  it('every declared number setting is clamped', () => {
    const declaredNumbers = [...declared].filter(([, v]) => v.type === 'number' || v.type === 'integer').map(([k]) => k).sort();
    assert.deepEqual(keys(NUMBER_SETTINGS).sort(), declaredNumbers);
  });
});

describe('validateQuickSetting', () => {
  const quick = QUICK_SETTING_KEYS as readonly string[];

  it('rejects an unknown key', () => {
    assert.equal(validateQuickSetting('nav.nope', true), undefined);
    assert.equal(validateQuickSetting('search.minLength', 3), undefined);
  });

  it('accepts exactly the listed values of an enum', () => {
    for (const key of keys(ENUM_SETTINGS).filter((k) => quick.includes(k))) {
      for (const v of ENUM_SETTINGS[key]) assert.equal(validateQuickSetting(key, v), v, `${key}=${v}`);
      for (const v of [...BAD, 'nonsense']) assert.equal(validateQuickSetting(key, v), undefined, `${key}=${inspect(v)}`);
    }
  });

  it('accepts the bounds of a number and nothing outside or non-finite', () => {
    for (const key of keys(NUMBER_SETTINGS).filter((k) => quick.includes(k))) {
      const { min, max } = NUMBER_SETTINGS[key];
      assert.equal(validateQuickSetting(key, min), min, key);
      assert.equal(validateQuickSetting(key, max), max, key);
      for (const v of [min - 1, max + 1, NaN, Infinity, String(min), null, undefined]) assert.equal(validateQuickSetting(key, v), undefined, `${key}=${inspect(v)}`);
    }
    assert.equal(validateQuickSetting('nav.maxDepth', 2.5), undefined);
    assert.equal(validateQuickSetting('body.lineHeight', 1.65), 1.65);
  });

  it("lets nav.width be reset with ''", () => {
    assert.equal(validateQuickSetting('nav.width', ''), '');
    assert.equal(validateQuickSetting('body.fontSize', ''), undefined);
  });

  it('validates booleans and colors', () => {
    assert.equal(validateQuickSetting('nav.show', false), false);
    assert.equal(validateQuickSetting('nav.show', 'true'), undefined);
    assert.equal(validateQuickSetting('table.headerTextColor', '#A0b1C2'), '#A0b1C2');
    assert.equal(validateQuickSetting('table.headerTextColor', ''), '');
    for (const v of ['red', '#fff', '#12345g', 12]) assert.equal(validateQuickSetting('table.headerTextColor', v), undefined);
  });

  it('only accepts values that the readers return unchanged', () => {
    for (const key of keys(ENUM_SETTINGS).filter((k): k is EnumSettingKey => quick.includes(k))) {
      for (const v of ENUM_SETTINGS[key]) assert.equal(readEnum(key, validateQuickSetting(key, v)), v, key);
    }
    for (const key of keys(NUMBER_SETTINGS).filter((k): k is NumberSettingKey => quick.includes(k))) {
      const { min, max } = NUMBER_SETTINGS[key];
      for (const v of [min, (min + max) / 2, max, Math.round((min + max) / 2)]) {
        const accepted = validateQuickSetting(key, v);
        if (accepted !== undefined) assert.equal(readNumber(key, accepted), accepted, `${key}=${inspect(v)}`);
      }
    }
  });
});
