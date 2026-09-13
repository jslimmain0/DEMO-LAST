# TCP 요청 작성 파훼법 1차 — 레이아웃 텍스트 계약 · [필드|텍스트] · 정의서 붙여넣기 · 거울 생성 · 응답 trim/type — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 처음 쓰는 사람이 정의서(엑셀)·텍스트 한 줄 문법으로 TCP 노드/TCP Mock 의 필드 표를 만들고, 한쪽(Mock)에서 다른쪽(노드)을 생성하며, 단일 실행이 편집 중 값·trim 된 응답으로 "첫 성공"에 이르게 한다.

**Architecture:** (1) 순수 lib `textForms.ts` 가 `TextForm<T>` 계약(toText/fromText+줄 단위 경고)으로 고정길이 전문 DSL·JSON(bare 토큰 스캐너)·urlencoded(percent 대칭)·헤더 폼을 제공하고, 공용 `FieldTextToggle` 이 어떤 필드 표든 [필드|텍스트] 로 감싼다. (2) `TcpLayoutPaste` 다이얼로그가 정의서 TSV/DSL 붙여넣기 → 표 → 적용(샘플 전문 대조는 기존 `tcp-preview`). (3) 순수 `tcpMirror.ts` 가 노드⇄Mock 을 변환하고 Mock 편집기/노드 패널 버튼이 이를 호출한다. (4) 백엔드는 단일 실행 노드 override 와 `TcpRespField.trim/type` 두 곳만.

**Tech Stack:** React 19 + TypeScript(프론트, `frontend/`), **vitest(신규 — 프론트 단위 테스트 러너)**, Spring Boot 3 / Kotlin(백엔드, `backend/`, JUnit5+AssertJ), Playwright(브라우저 e2e — 세션 스크래치 관례).

**Spec:** `docs/superpowers/specs/2026-09-11-tcp-request-authoring-ux-design.md` (§3 P1·P2·P4·횡단, §4 1차 행, §5 1차 1~7)

## Global Constraints

- UI 텍스트는 전부 한국어. 기존 그래프/Mock spec 100% 호환(새 필드는 optional, 기존 값 무회귀).
- 백엔드 테스트는 `backend/` 에서 `./gradlew :test`(루트 `./gradlew test` 는 plugin-sample 의존성으로 깨질 수 있음). 프론트는 `frontend/` 에서 `npm test`(vitest) · `npx tsc -b` · `npm run lint` · `npm run build`.
- Jackson 역직렬화 DTO 에 `@get:JvmName` 금지. 새 Kotlin 필드는 nullable(레거시 JSON 호환).
- DSL 결정(사용자 확정): 직렬화는 **공백 구분** `이름 길이 종류 [인코딩] [= 값]`. 대괄호 표기는 받지 않는다(YAGNI).
- 응답 trim 기본값: **새 노드만 true**(`nodeFactory`), 저장된 그래프의 `trim == null` 은 false(무회귀).
- 커밋 메시지는 한국어 `feat/fix/test/docs(scope): …` + 트레일러 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` / `Claude-Session: https://claude.ai/code/session_015D7zBGLc7rVy3vDsMZaV2x`. `backend/build.gradle.kts` 의 미커밋 변경(`danal-base`)은 **커밋에 넣지 않는다**(사용자 작업).
- 붙여넣기/텍스트 파싱은 절대 throw 하지 않는다 — 실패 줄은 `warnings` 로.

---

## Part A — 텍스트 계약 · 토글 · 붙여넣기

### Task 1: vitest 도입 + 첫 테스트(bodyConvert 왕복)

**Files:**
- Modify: `frontend/package.json` (scripts.test, devDependencies.vitest)
- Create: `frontend/vitest.config.ts`
- Create: `frontend/src/lib/bodyConvert.test.ts`

**Interfaces:**
- Produces: `npm test` = `vitest run`(node 환경, `src/**/*.test.ts`). 이후 모든 Task 의 프론트 단위 테스트가 이 러너를 쓴다.

- [ ] **Step 1: vitest 설치**

Run (in `frontend/`): `npm install -D vitest@^3`
Expected: `package.json` devDependencies 에 `"vitest": "^3.x"` 추가, `package-lock.json` 갱신.

- [ ] **Step 2: 스크립트·설정 추가**

`frontend/package.json` scripts 에 추가:
```json
"test": "vitest run",
"test:watch": "vitest"
```

`frontend/vitest.config.ts` 생성:
```ts
import { defineConfig } from 'vitest/config'

// 순수 lib 단위 테스트 전용(DOM 불필요) — src/**/*.test.ts 만. 브라우저 e2e 는 Playwright(스크래치)로 별도.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
```

- [ ] **Step 3: 실패하는 첫 테스트(기존 bodyConvert 왕복)**

`frontend/src/lib/bodyConvert.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { fieldsToRaw, rawToFields, headersToRaw, rawToHeaders } from './bodyConvert'

describe('bodyConvert 왕복', () => {
  it('json 필드 → raw → 필드 (타입 보존)', () => {
    const rows = [{ key: 'name', value: 'kim', type: 'string' }, { key: 'age', value: '30', type: 'number' }, { key: 'ok', value: 'true', type: 'boolean' }]
    const back = rawToFields(fieldsToRaw(rows, 'json'), 'json')
    expect(back).toEqual(rows)
  })
  it('urlencoded 왕복', () => {
    const rows = [{ key: 'a', value: '1' }, { key: 'b', value: 'x y' }]
    expect(rawToFields(fieldsToRaw(rows, 'urlencoded'), 'urlencoded')).toEqual(rows)
  })
  it('헤더: 콜론 없는 줄이 있으면 null', () => {
    expect(rawToHeaders('A: 1\nbroken')).toBeNull()
    expect(rawToHeaders(headersToRaw([{ key: 'A', value: '1' }]))).toEqual([{ key: 'A', value: '1' }])
  })
})
```

- [ ] **Step 4: 실행해 통과 확인**

Run (in `frontend/`): `npm test`
Expected: `3 passed`. (`tsc -b` 가 테스트 파일을 컴파일 대상에 넣지 않게 `tsconfig.app.json` 의 `include`/`exclude` 를 확인 — `src/**/*.test.ts` 가 포함되면 vitest 전역 타입이 없어 tsc 가 실패할 수 있다. 그 경우 `tsconfig.app.json` `exclude` 에 `"src/**/*.test.ts"` 추가.)

Run: `npx tsc -b` → 에러 0.

- [ ] **Step 5: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/vitest.config.ts frontend/src/lib/bodyConvert.test.ts frontend/tsconfig.app.json
git commit -m "test(frontend): vitest 도입 — 순수 lib 단위 테스트 러너(bodyConvert 왕복 3종)"
```

---

### Task 2: `lib/textForms.ts` — TextForm 계약 + 고정길이 전문 DSL(3모드)

**Files:**
- Create: `frontend/src/lib/textForms.ts`
- Create: `frontend/src/lib/textForms.test.ts`
- Modify: `frontend/src/api/types.ts:134-139` (`TcpRespField` 에 `trim?`, `type?` 추가 — Task 12 백엔드와 짝)

**Interfaces:**
- Consumes: `newId()`(`lib/ids`), `bindingToToken/isTokenizable`(`lib/tokenGrammar`), `Binding`(`api/types`).
- Produces(이후 Task 가 그대로 쓰는 이름):
  ```ts
  export interface ParseWarning { line: number; text: string; reason: string }
  export interface TextForm<T> { id: string; label: string; placeholder: string; toText(rows: T[]): string; fromText(text: string, prev: T[]): { rows: T[]; warnings: ParseWarning[] } }
  export type LayoutMode = 'request' | 'response' | 'layout'
  export interface LayoutRow { id: string; name?: string; length?: number; value?: string | null; bound?: Binding | null; pad?: 'left' | 'right'; padChar?: string; encoding?: string; trim?: boolean; type?: 'string' | 'number' }
  export function tcpLayoutForm(mode: LayoutMode): TextForm<LayoutRow>
  export function parseTcpLayout(text: string, mode: LayoutMode, prev?: LayoutRow[]): { rows: LayoutRow[]; warnings: ParseWarning[]; headerMapped: boolean }
  export function tcpLayoutToText(rows: LayoutRow[], mode: LayoutMode): string
  export function normalizeLayoutRow(r: LayoutRow, mode: LayoutMode): LayoutRow   // 테스트·diff 용 정규화(pad 기본값 채움)
  ```
  모드 의미: `request` = 노드 요청 필드 / Mock 규칙 응답 필드(값·패딩·인코딩) · `response` = 노드 응답 필드(이름·길이·인코딩·종류→type/trim) · `layout` = Mock 요청 레이아웃(이름·길이·인코딩만).

- [ ] **Step 1: 타입 추가**

`frontend/src/api/types.ts` 의 `TcpRespField` 를 다음으로 교체:
```ts
export interface TcpRespField {
  id: string
  name?: string
  length?: number
  encoding?: string
  /** 슬라이스 후 패딩 제거(문자=후행 공백, 숫자=선행 0·공백). 새 노드 기본 true, 저장된 그래프의 undefined 는 false(무회귀). */
  trim?: boolean
  /** 출력 타입 — number 면 trim 후 숫자 원형(조건식 숫자 비교). 기본 string. */
  type?: 'string' | 'number'
}
```

- [ ] **Step 2: 실패하는 테스트**

`frontend/src/lib/textForms.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { normalizeLayoutRow, parseTcpLayout, tcpLayoutForm, tcpLayoutToText, type LayoutRow } from './textForms'

const strip = (rows: LayoutRow[], mode: 'request' | 'response' | 'layout') => rows.map((r) => { const { id: _id, ...rest } = normalizeLayoutRow(r, mode); return rest })

describe('tcp DSL — request 모드(값·패딩)', () => {
  it('직렬화 → 파싱 왕복(정규화 기준 동일)', () => {
    const rows: LayoutRow[] = [
      { id: 'a', name: '전문코드', length: 4, value: '0200', pad: 'right', padChar: ' ' },
      { id: 'b', name: '계좌번호', length: 12, value: '{{ acct@set1 }}', pad: 'left', padChar: '0' },
      { id: 'c', name: '송신 기관코드', length: 8, value: '', pad: 'right', padChar: '*', encoding: 'UTF-8' },
      { id: 'd', name: '비고', length: 10, value: ' 앞공백 ' },
    ]
    const text = tcpLayoutToText(rows, 'request')
    expect(text.split('\n')[0]).toBe('전문코드 4 문자 = 0200')
    expect(text.split('\n')[1]).toBe('계좌번호 12 숫자 = {{ acct@set1 }}')
    expect(text.split('\n')[2]).toBe('"송신 기관코드" 8 R* UTF-8')
    expect(text.split('\n')[3]).toBe('비고 10 문자 = " 앞공백 "')
    const back = parseTcpLayout(text, 'request', rows)
    expect(back.warnings).toEqual([])
    expect(back.rows.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']) // prev id 승계(위치+이름)
    expect(strip(back.rows, 'request')).toEqual(strip(rows, 'request'))
  })
  it('종류 별칭·PIC·패딩 이스케이프·주석·빈 줄', () => {
    const { rows, warnings } = parseTcpLayout('# 주석\n\n금액 X(10) N\n이름 9(3)V99\n구분 1 L\\,\n코드 2 R_ ms949', 'request')
    expect(warnings).toEqual([])
    expect(rows.map((r) => [r.name, r.length, r.pad, r.padChar, r.encoding])).toEqual([
      ['금액', 10, 'left', '0', undefined],   // 명시 종류 N 이 PIC 의 X 보다 우선
      ['이름', 5, 'left', '0', undefined],    // 9(3)V99 = 3+2, 숫자
      ['구분', 1, 'left', ',', undefined],
      ['코드', 2, 'right', ' ', 'MS949'],
    ])
  })
  it('실패 줄은 경고로, 나머지는 살아남는다(throw 없음)', () => {
    const { rows, warnings } = parseTcpLayout('ok 4\n길이없음\n이상 abc\nfine 2 = x', 'request')
    expect(rows.map((r) => r.name)).toEqual(['ok', 'fine'])
    expect(warnings.map((w) => w.line)).toEqual([2, 3])
  })
  it('bound 복원: 텍스트가 같은 토큰이면 prev 의 bound 유지', () => {
    const prev: LayoutRow[] = [{ id: 'x', name: 'k', length: 4, value: null, bound: { key: 'amt', sourceId: 'n1', scope: 'out' } as never }]
    const text = tcpLayoutToText(prev, 'request')
    expect(text).toBe('k 4 문자 = {{ amt@n1 }}')
    const back = parseTcpLayout(text, 'request', prev)
    expect(back.rows[0].bound).toEqual(prev[0].bound)
    expect(back.rows[0].value).toBeNull()
  })
})

describe('tcp DSL — 엑셀 TSV 헤더 매핑', () => {
  it('항목명/길이/타입/기본값 열을 찾아 매핑, 순번 열 무시', () => {
    const tsv = '순번\t항목명\t길이\t타입\t기본값\t설명\n1\t전문코드\t4\tAN\t0200\t거래코드\n2\t계좌번호\t12\tN\t\t좌측 0\n3\t고객명\t10\tK\t\t한글'
    const r = parseTcpLayout(tsv, 'request')
    expect(r.headerMapped).toBe(true)
    expect(r.warnings).toEqual([])
    expect(r.rows.map((x) => [x.name, x.length, x.pad, x.padChar, x.value])).toEqual([
      ['전문코드', 4, 'right', ' ', '0200'], ['계좌번호', 12, 'left', '0', ''], ['고객명', 10, 'right', ' ', ''],
    ])
  })
  it('마크다운 표(| 구분·--- 줄)도 같은 규칙', () => {
    const md = '| 항목 | 길이 | 유형 |\n|---|---|---|\n| 코드 | 4 | X |\n| 금액 | 8 | 9 |'
    const r = parseTcpLayout(md, 'layout')
    expect(r.rows.map((x) => [x.name, x.length])).toEqual([['코드', 4], ['금액', 8]])
  })
})

describe('tcp DSL — response/layout 모드', () => {
  it('response: 종류가 type/trim 이 되고 값은 무시(경고)', () => {
    const r = parseTcpLayout('응답코드 4 문자\n잔액 12 숫자\n고객명 10 = 무시됨', 'response')
    expect(r.rows.map((x) => [x.name, x.length, x.type, x.trim])).toEqual([['응답코드', 4, 'string', true], ['잔액', 12, 'number', true], ['고객명', 10, undefined, undefined]])
    expect(r.warnings).toHaveLength(1)
    expect(tcpLayoutToText(r.rows, 'response')).toBe('응답코드 4 문자\n잔액 12 숫자\n고객명 10')
  })
  it('layout: 이름·길이·인코딩만', () => {
    const rows: LayoutRow[] = [{ id: '1', name: '전문코드', length: 4 }, { id: '2', name: '고객명', length: 10, encoding: 'EUC-KR' }]
    const text = tcpLayoutToText(rows, 'layout')
    expect(text).toBe('전문코드 4\n고객명 10 EUC-KR')
    expect(strip(parseTcpLayout(text, 'layout', rows).rows, 'layout')).toEqual(strip(rows, 'layout'))
  })
  it('TextForm 계약: form.fromText(form.toText(rows)) ≡ rows', () => {
    const form = tcpLayoutForm('request')
    const rows: LayoutRow[] = [{ id: 'q', name: 'a', length: 3, value: 'x', pad: 'right', padChar: ' ' }]
    expect(strip(form.fromText(form.toText(rows), rows).rows, 'request')).toEqual(strip(rows, 'request'))
  })
})
```

- [ ] **Step 3: 실행해 실패 확인**

Run (in `frontend/`): `npm test`
Expected: FAIL — `Cannot find module './textForms'`.

- [ ] **Step 4: 구현**

`frontend/src/lib/textForms.ts`:
```ts
import type { Binding } from '../api/types'
import { newId } from './ids'
import { bindingToToken } from './tokenGrammar'

/**
 * 텍스트 폼 계약 — 구조화 표(필드 목록) ⇄ 사람이 쓰는 텍스트. 순수(런타임 의존성 0).
 * 규칙: (1) toText 는 항상 성공 (2) fromText 는 절대 throw 하지 않고 실패 줄을 warnings 로 보고(그 줄은 모델에서 빠짐)
 * (3) fromText(toText(rows)) ≡ rows (id 제외, 정규화 기준) 을 각 폼의 테스트가 고정한다
 * (4) prev 는 id 승계(React key·TokenInput 안정)와 bound 복원에 쓴다.
 */
export interface ParseWarning { line: number; text: string; reason: string }
export interface TextForm<T> {
  id: string
  label: string
  placeholder: string
  toText(rows: T[]): string
  fromText(text: string, prev: T[]): { rows: T[]; warnings: ParseWarning[] }
}

// ───────────────────────── 고정길이 전문 레이아웃 DSL ─────────────────────────
// 한 줄 = 한 필드:  이름 길이 [종류] [패딩] [인코딩] [= 값]
//   이름   공백/,/|/=/#/" 가 들어가면 "…" 로 감싼다(JSON 문자열 규칙)
//   길이   바이트 정수 | PIC — X(10) 9(12) S9(10)V99 A(3) N(4) (PIC 접두 허용, 길이=합)
//   종류   문자|숫자|한글|영숫자|AN|X|A|C|K|H|N|9|S9   (N/9/S9/숫자 → 좌측 0 패딩·숫자, 그 외 → 우측 공백·문자)
//   패딩   L? | R? — 방향 + 문자 1개('_'=공백, '\,' '\#' '\ ' 이스케이프). 종류보다 우선.
//   인코딩 EUC-KR|MS949|UTF-8|US-ASCII
//   값     첫 '=' 이후 줄 끝(양끝 공백 제거). {{ 토큰 }} 그대로. 앞뒤 공백/개행/따옴표가 필요하면 "…"
// 엑셀에서 복사한 TSV/CSV/마크다운 표는 첫 줄이 헤더(항목명/길이/타입/기본값…)면 열 매핑으로 읽는다. 순번 열은 버린다.

export type LayoutMode = 'request' | 'response' | 'layout'
export interface LayoutRow {
  id: string
  name?: string
  length?: number
  value?: string | null
  bound?: Binding | null
  pad?: 'left' | 'right'
  padChar?: string
  encoding?: string
  trim?: boolean
  type?: 'string' | 'number'
}

const ENCODINGS: Record<string, string> = { 'euc-kr': 'EUC-KR', 'ms949': 'MS949', 'utf-8': 'UTF-8', 'utf8': 'UTF-8', 'us-ascii': 'US-ASCII', 'ascii': 'US-ASCII' }
const NUM_KINDS = new Set(['숫자', 'n', '9', 's9', 'num', 'number'])
const CHAR_KINDS = new Set(['문자', '한글', '영숫자', 'an', 'x', 'a', 'c', 'k', 'h', 'char', 'string', 'str'])
const HEADER_KEYS = {
  name: ['항목명', '항목', '필드명', '필드', '이름', '명칭', 'name', 'field'],
  length: ['길이', '바이트', 'len', 'length', 'size', 'bytes'],
  type: ['타입', '유형', '형식', '속성', 'type', 'kind'],
  value: ['기본값', '값', '샘플', '예시', 'value', 'default', 'example', 'sample'],
  encoding: ['인코딩', 'encoding', 'charset'],
}

type Kind = 'num' | 'char'
const kindOf = (tok: string): Kind | null => { const t = tok.toLowerCase(); return NUM_KINDS.has(t) ? 'num' : CHAR_KINDS.has(t) ? 'char' : null }

/** PIC/정수 길이 토큰 → {length, kind}. 아니면 null. */
function parseLength(tok: string): { length: number; kind: Kind | null } | null {
  const t = tok.trim()
  if (/^\d+$/.test(t)) return { length: Number(t), kind: null }
  const m = /^(?:PIC\s+)?(S?9|X|A|AN|N)\((\d+)\)(?:V(?:9\((\d+)\)|(9+)))?$/i.exec(t)
  if (!m) return null
  const base = Number(m[2])
  const dec = m[3] ? Number(m[3]) : m[4] ? m[4].length : 0
  const letter = m[1].toUpperCase()
  return { length: base + dec, kind: letter === '9' || letter === 'S9' || letter === 'N' ? 'num' : 'char' }
}

/** 패딩 지정 `L0` `R_` `L\,` → {pad, padChar}. 아니면 null. */
function parsePadSpec(tok: string): { pad: 'left' | 'right'; padChar: string } | null {
  const m = /^([LR])(\\?)(.)$/.exec(tok)
  if (!m) return null
  const ch = m[3] === '_' && !m[2] ? ' ' : m[3]
  return { pad: m[1] === 'L' ? 'left' : 'right', padChar: ch }
}

/** 따옴표를 존중하며 공백/쉼표/파이프/탭으로 토큰 분리. 첫 최상위 '=' 이후는 값(하나의 토큰)으로 돌려준다. */
function tokenize(line: string): { tokens: string[]; value: string | null } {
  const tokens: string[] = []
  let cur = ''
  let inQ = false
  let i = 0
  const push = () => { if (cur !== '') { tokens.push(cur); cur = '' } }
  while (i < line.length) {
    const ch = line[i]
    if (inQ) {
      if (ch === '\\' && i + 1 < line.length) { cur += ch + line[i + 1]; i += 2; continue }
      if (ch === '"') { cur += ch; inQ = false; i++; continue }
      cur += ch; i++; continue
    }
    if (ch === '"') { inQ = true; cur += ch; i++; continue }
    if (ch === '=') { push(); return { tokens, value: line.slice(i + 1).trim() } }
    if (ch === '\\' && i + 1 < line.length) { cur += ch + line[i + 1]; i += 2; continue }
    if (ch === ' ' || ch === '\t' || ch === ',' || ch === '|') { push(); i++; continue }
    cur += ch; i++
  }
  push()
  return { tokens, value: null }
}

function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) { try { return JSON.parse(s) } catch { return s.slice(1, -1) } }
  return s
}
function quoteName(name: string): string {
  return name === '' || /[\s,|=#"\\]/.test(name) ? JSON.stringify(name) : name
}
function quoteValue(v: string): string {
  return v !== v.trim() || /[\r\n]/.test(v) || v.startsWith('"') ? JSON.stringify(v) : v
}
function padSpecText(pad: 'left' | 'right', ch: string): string {
  const c = ch === ' ' ? '_' : /[,|=#\\\s]/.test(ch) ? '\\' + ch : ch
  return (pad === 'left' ? 'L' : 'R') + c
}

/** 헤더 줄이면 열 → 역할 매핑, 아니면 null. */
function mapHeader(cells: string[]): Partial<Record<keyof typeof HEADER_KEYS, number>> | null {
  const map: Partial<Record<keyof typeof HEADER_KEYS, number>> = {}
  cells.forEach((c, i) => {
    const t = c.trim().toLowerCase().replace(/[\s()]/g, '')
    for (const k of Object.keys(HEADER_KEYS) as Array<keyof typeof HEADER_KEYS>) {
      if (map[k] === undefined && HEADER_KEYS[k].some((kw) => t === kw || t.startsWith(kw))) { map[k] = i; break }
    }
  })
  return map.name !== undefined && map.length !== undefined ? map : null
}
function splitCells(line: string): string[] {
  if (line.includes('\t')) return line.split('\t')
  if (line.includes('|')) return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|')
  if (line.includes(',')) return line.split(',')
  return line.split(/\s{2,}/)
}
const isSepRow = (line: string) => /^\s*\|?(\s*:?-{2,}:?\s*\|?)+\s*$/.test(line)

export function normalizeLayoutRow(r: LayoutRow, mode: LayoutMode): LayoutRow {
  const out: LayoutRow = { id: r.id, name: r.name ?? '', length: r.length ?? 0 }
  if (r.encoding) out.encoding = r.encoding
  if (mode === 'request') {
    out.pad = r.pad ?? 'right'
    out.padChar = (r.padChar ?? ' ').slice(0, 1) || ' '
    if (r.bound) { out.bound = r.bound; out.value = null } else out.value = r.value ?? ''
  } else if (mode === 'response') {
    if (r.type) out.type = r.type
    if (r.trim !== undefined) out.trim = r.trim
  }
  return out
}

export function tcpLayoutToText(rows: LayoutRow[], mode: LayoutMode): string {
  return rows.map((raw) => {
    const r = normalizeLayoutRow(raw, mode)
    const parts = [quoteName(r.name ?? ''), String(r.length ?? 0)]
    if (mode === 'request') {
      const pad = r.pad ?? 'right', ch = r.padChar ?? ' '
      if (pad === 'left' && ch === '0') parts.push('숫자')
      else if (pad === 'right' && ch === ' ') parts.push('문자')
      else parts.push(padSpecText(pad, ch))
    } else if (mode === 'response') {
      if (r.type === 'number') parts.push('숫자')
      else if (r.type === 'string' || r.trim) parts.push('문자')
    }
    if (r.encoding) parts.push(r.encoding)
    if (mode === 'request') {
      const v = raw.bound ? bindingToToken(raw.bound) : (r.value ?? '')
      if (v !== '') parts.push('= ' + quoteValue(v))
    }
    return parts.join(' ')
  }).join('\n')
}

export function parseTcpLayout(text: string, mode: LayoutMode, prev: LayoutRow[] = []): { rows: LayoutRow[]; warnings: ParseWarning[]; headerMapped: boolean } {
  const rows: LayoutRow[] = []
  const warnings: ParseWarning[] = []
  let header: ReturnType<typeof mapHeader> = null
  let headerMapped = false
  const lines = (text ?? '').split(/\r?\n/)
  lines.forEach((rawLine, idx) => {
    const lineNo = idx + 1
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#') || isSepRow(line)) return
    let draft: { name: string; length: number; kind: Kind | null; padSpec: ReturnType<typeof parsePadSpec>; encoding?: string; value: string | null } | null = null
    if (header) {
      const cells = splitCells(rawLine).map((c) => c.trim())
      const len = parseLength(cells[header.length!] ?? '')
      const name = unquote(cells[header.name!] ?? '')
      if (!len || name === '') { warnings.push({ line: lineNo, text: rawLine, reason: '이름 또는 길이 열을 읽을 수 없음' }); return }
      const typeTok = header.type !== undefined ? (cells[header.type] ?? '') : ''
      draft = { name, length: len.length, kind: (typeTok && kindOf(typeTok)) || len.kind, padSpec: null,
        encoding: header.encoding !== undefined ? ENCODINGS[(cells[header.encoding] ?? '').toLowerCase()] : undefined,
        value: header.value !== undefined ? unquote(cells[header.value] ?? '') : null }
    } else {
      const { tokens, value } = tokenize(line)
      // 첫 유효 줄이 필드로 안 읽히고 헤더 키워드를 품으면 열 매핑 모드
      if (rows.length === 0 && !headerMapped && (tokens.length < 2 || !parseLength(tokens[1]) && !(tokens.length >= 3 && /^\d+$/.test(tokens[0]) && parseLength(tokens[2])))) {
        const h = mapHeader(splitCells(rawLine))
        if (h) { header = h; headerMapped = true; return }
      }
      let toks = tokens
      if (toks.length >= 3 && /^\d+$/.test(toks[0]) && !parseLength(toks[1]) && parseLength(toks[2])) toks = toks.slice(1) // 순번 열
      if (toks.length < 2) { warnings.push({ line: lineNo, text: rawLine, reason: '이름과 길이가 필요합니다 (예: 계좌번호 12 숫자)' }); return }
      const len = parseLength(toks[1])
      if (!len) { warnings.push({ line: lineNo, text: rawLine, reason: `길이를 읽을 수 없음: '${toks[1]}'` }); return }
      draft = { name: unquote(toks[0]), length: len.length, kind: len.kind, padSpec: null, value }
      for (const a of toks.slice(2)) {
        const k = kindOf(a); const ps = parsePadSpec(a); const enc = ENCODINGS[a.toLowerCase()]
        if (k) draft.kind = k
        else if (ps) draft.padSpec = ps
        else if (enc) draft.encoding = enc
        else warnings.push({ line: lineNo, text: rawLine, reason: `알 수 없는 속성 '${a}' 무시` })
      }
    }
    if (!draft) return
    const row: LayoutRow = { id: '', name: draft.name, length: draft.length }
    if (draft.encoding) row.encoding = draft.encoding
    if (mode === 'request') {
      const pad = draft.padSpec ?? (draft.kind === 'num' ? { pad: 'left' as const, padChar: '0' } : { pad: 'right' as const, padChar: ' ' })
      row.pad = pad.pad; row.padChar = pad.padChar
      row.value = draft.value === null ? '' : unquote(draft.value)
    } else {
      if (draft.value !== null && draft.value !== '') warnings.push({ line: lineNo, text: rawLine, reason: '이 목록은 값이 없습니다 — "= 값" 무시' })
      if (mode === 'response' && draft.kind) { row.type = draft.kind === 'num' ? 'number' : 'string'; row.trim = true }
    }
    rows.push(row)
  })
  // prev id 승계: 같은 위치 같은 이름 → 이름 첫 매칭 → 새 id. bound 복원(값이 같은 토큰이면).
  const used = new Set<string>()
  rows.forEach((r, i) => {
    const byPos = prev[i] && (prev[i].name ?? '') === (r.name ?? '') && !used.has(prev[i].id) ? prev[i] : undefined
    const p = byPos ?? prev.find((x) => !used.has(x.id) && (x.name ?? '') === (r.name ?? ''))
    r.id = p ? p.id : newId()
    if (p) used.add(p.id)
    if (mode === 'request' && p?.bound && r.value === bindingToToken(p.bound)) { r.bound = p.bound; r.value = null }
  })
  return { rows, warnings, headerMapped }
}

export function tcpLayoutForm(mode: LayoutMode): TextForm<LayoutRow> {
  const placeholder = mode === 'request'
    ? '한 줄에 필드 하나 — 이름 길이 종류 [= 값]\n전문코드 4 문자 = 0200\n계좌번호 12 숫자 = {{ acct@set1 }}\n(엑셀 정의서 행을 그대로 붙여넣어도 됩니다: 항목명 / 길이 / 타입 / 기본값)'
    : mode === 'response'
      ? '한 줄에 필드 하나 — 이름 길이 [종류]\n응답코드 4 문자\n잔액 12 숫자   (숫자 = 선행 0 제거 + 숫자 출력)\n고객명 10'
      : '한 줄에 필드 하나 — 이름 길이 [인코딩]\n전문코드 4\n계좌번호 10\n고객명 10 EUC-KR'
  return {
    id: `tcp-${mode}`,
    label: '고정길이 전문 텍스트(한 줄 = 한 필드)',
    placeholder,
    toText: (rows) => tcpLayoutToText(rows, mode),
    fromText: (text, prev) => { const r = parseTcpLayout(text, mode, prev); return { rows: r.rows, warnings: r.warnings } },
  }
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run (in `frontend/`): `npm test`
Expected: textForms 테스트 전부 PASS. 실패하면 파서를 고치되 테스트 기대값(문법 확정안)은 바꾸지 않는다.

Run: `npx tsc -b` → 에러 0.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/textForms.ts frontend/src/lib/textForms.test.ts frontend/src/api/types.ts
git commit -m "feat(frontend): 고정길이 전문 레이아웃 DSL — TextForm 계약 + 3모드(request/response/layout) 파서·직렬화, 엑셀 TSV 헤더 매핑, PIC, 왕복 테스트"
```

---

### Task 3: JSON bare 토큰 스캐너 · urlencoded percent 대칭 · 헤더 부분 허용 폼

**Files:**
- Modify: `frontend/src/lib/bodyConvert.ts:97-118` (`jsonValueLiteral` 에 `raw` 타입)
- Modify: `frontend/src/lib/textForms.ts` (폼 3종 추가)
- Modify: `frontend/src/lib/textForms.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface KvRow { id: string; key: string; value: string; type?: string }
  export const jsonBodyForm: TextForm<KvRow>      // JSON 본문 — number/boolean/json/array 타입의 단일 토큰 값은 따옴표 없이(bare) 직렬화, 되돌릴 때 prev 타입 승계
  export const kvUrlForm: TextForm<KvRow>         // urlencoded — 값·키 percent 인코딩(토큰 세그먼트 제외), %XX 만 디코딩('+' 는 그대로)
  export const headersForm: TextForm<KvRow>       // Key: Value 줄 — 콜론 없는 줄은 경고로 건너뜀
  export function protectBareTokens(text: string): { json: string; tokens: string[] }
  ```

- [ ] **Step 1: 실패하는 테스트 추가**

`frontend/src/lib/textForms.test.ts` 끝에 추가:
```ts
import { headersForm, jsonBodyForm, kvUrlForm, protectBareTokens, type KvRow } from './textForms'

describe('jsonBodyForm — bare 토큰', () => {
  it('number+단일 토큰은 따옴표 없이, 되돌리면 prev 타입 승계', () => {
    const rows: KvRow[] = [{ id: '1', key: 'amount', value: '{{ amt@prev }}', type: 'number' }, { id: '2', key: 'url', value: '/o/{{ id@n1 }}', type: 'string' }]
    const text = jsonBodyForm.toText(rows)
    expect(text).toContain('"amount": {{ amt@prev }}')
    expect(text).toContain('"url": "/o/{{ id@n1 }}"')
    const back = jsonBodyForm.fromText(text, rows)
    expect(back.warnings).toEqual([])
    expect(back.rows).toEqual(rows)
  })
  it('문자열 안의 {{ }} 는 건드리지 않는다', () => {
    const { json, tokens } = protectBareTokens('{"a": "x {{ t@n }} y", "b": {{ u@n }}}')
    expect(tokens).toEqual(['{{ u@n }}'])
    expect(JSON.parse(json)).toEqual({ a: 'x {{ t@n }} y', b: '__FLTK0__' })
  })
  it('prev 에 없는 bare 토큰은 json 타입', () => {
    const back = jsonBodyForm.fromText('{"n": {{ x@y }}}', [])
    expect(back.rows[0]).toMatchObject({ key: 'n', value: '{{ x@y }}', type: 'json' })
  })
  it('깨진 JSON 은 rows 비움 + 경고 1', () => {
    const back = jsonBodyForm.fromText('{"a": ', [])
    expect(back.rows).toEqual([]); expect(back.warnings).toHaveLength(1)
  })
})

describe('kvUrlForm — percent 대칭', () => {
  it('값의 & = 공백은 인코딩, 토큰은 그대로, 왕복 동일', () => {
    const rows: KvRow[] = [{ id: '1', key: 'q', value: 'a&b=c d' }, { id: '2', key: 'id', value: '{{ id@n1 }}-x' }]
    const text = kvUrlForm.toText(rows)
    expect(text).toBe('q=a%26b%3Dc%20d&id={{ id@n1 }}-x')
    expect(kvUrlForm.fromText(text, rows).rows).toEqual(rows)
  })
  it("'+' 는 디코딩하지 않는다(기존 raw 호환)", () => {
    expect(kvUrlForm.fromText('a=1+2', []).rows[0].value).toBe('1+2')
  })
})

describe('headersForm — 부분 허용', () => {
  it('콜론 없는 줄은 경고, 나머지는 변환', () => {
    const back = headersForm.fromText('A: 1\nbroken\nB: {{ t@secret }}', [])
    expect(back.rows.map((r) => [r.key, r.value])).toEqual([['A', '1'], ['B', '{{ t@secret }}']])
    expect(back.warnings).toEqual([{ line: 2, text: 'broken', reason: '"이름: 값" 형식이 아닙니다' }])
  })
})
```

- [ ] **Step 2: 실행해 실패 확인**

Run: `npm test` → FAIL (`jsonBodyForm` 미정의).

- [ ] **Step 3: bodyConvert 에 raw 타입**

`frontend/src/lib/bodyConvert.ts` `jsonValueLiteral` 의 `switch (type)` 에 `case 'number':` 앞에 추가:
```ts
    case 'raw': // 이미 JSON 리터럴/bare 토큰 — 그대로(jsonBodyForm 이 number/boolean/json 타입의 단일 토큰에 씀)
      return v
```

- [ ] **Step 4: 폼 3종 구현**

`frontend/src/lib/textForms.ts` 상단 import 에 `import { fieldsToRaw, rawToFields, headersToRaw } from './bodyConvert'` 와 `import { segmentValue } from './tokenGrammar'` 추가, 파일 끝에 추가:
```ts
// ───────────────────────── 키-값 폼(HTTP 본문/쿼리/헤더) ─────────────────────────
export interface KvRow { id: string; key: string; value: string; type?: string }
const BARE_TYPES = new Set(['number', 'boolean', 'json', 'array'])
const isSingleToken = (v: string) => /^\{\{[^{}]*\}\}$/.test(v.trim())

/** 문자열 밖의 {{…}} 를 "__FLTKn__" 문자열 리터럴로 치환(문자열 안은 그대로) — JSON.parse 가능하게. */
export function protectBareTokens(text: string): { json: string; tokens: string[] } {
  const tokens: string[] = []
  let out = ''
  let inStr = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      out += ch
      if (ch === '\\' && i + 1 < text.length) { out += text[i + 1]; i++ } else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; out += ch; continue }
    if (ch === '{' && text[i + 1] === '{') {
      const end = text.indexOf('}}', i + 2)
      if (end > 0) { tokens.push(text.slice(i, end + 2)); out += `"__FLTK${tokens.length - 1}__"`; i = end + 1; continue }
    }
    out += ch
  }
  return { json: out, tokens }
}

function reuseIds<T extends { id: string; key: string }>(rows: Array<Omit<T, 'id'>>, prev: T[]): T[] {
  const used = new Set<string>()
  return rows.map((r, i) => {
    const p = (prev[i] && prev[i].key === r.key && !used.has(prev[i].id) ? prev[i] : undefined) ?? prev.find((x) => !used.has(x.id) && x.key === r.key)
    if (p) used.add(p.id)
    return { ...r, id: p ? p.id : newId() } as T
  })
}

export const jsonBodyForm: TextForm<KvRow> = {
  id: 'json-body', label: 'JSON 본문', placeholder: '{\n  "name": "kim",\n  "amount": {{ amt@prev }}\n}',
  toText: (rows) => fieldsToRaw(rows.map((r) => (r.type && BARE_TYPES.has(r.type) && isSingleToken(r.value) ? { ...r, type: 'raw' } : r)), 'json'),
  fromText: (text, prev) => {
    const { json, tokens } = protectBareTokens(text)
    const parsed = rawToFields(json, 'json')
    if (parsed === null) return { rows: [], warnings: [{ line: 1, text: text.slice(0, 80), reason: '유효한 JSON 객체가 아닙니다' }] }
    const rows = parsed.map((kv) => {
      const m = /^__FLTK(\d+)__$/.exec(kv.value)
      if (!m) return { key: kv.key, value: kv.value.replace(/__FLTK(\d+)__/g, (_s, n) => tokens[Number(n)] ?? _s), type: kv.type }
      const pt = prev.find((p) => p.key === kv.key)?.type
      return { key: kv.key, value: tokens[Number(m[1])] ?? kv.value, type: pt && BARE_TYPES.has(pt) ? pt : 'json' }
    })
    return { rows: reuseIds<KvRow>(rows, prev), warnings: [] }
  },
}

const encodePart = (s: string) => segmentValue(s).map((seg) => (seg.type === 'token' ? seg.raw : encodeURIComponent(seg.text))).join('')
const decodePercent = (s: string) => s.replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) => { try { return decodeURIComponent(m) } catch { return m } })

export const kvUrlForm: TextForm<KvRow> = {
  id: 'kv-url', label: 'urlencoded (키=값&키=값)', placeholder: 'a=1&b={{ x@n1 }}',
  toText: (rows) => rows.filter((r) => r.key.trim() !== '').map((r) => `${encodePart(r.key)}=${encodePart(r.value ?? '')}`).join('&'),
  fromText: (text, prev) => {
    const t = text.trim()
    const rows = t === '' ? [] : t.split('&').filter((p) => p !== '').map((pair) => {
      const i = pair.indexOf('=')
      return { key: decodePercent((i >= 0 ? pair.slice(0, i) : pair).trim()), value: i >= 0 ? decodePercent(pair.slice(i + 1)) : '' }
    })
    return { rows: reuseIds<KvRow>(rows, prev), warnings: [] }
  },
}

export const headersForm: TextForm<KvRow> = {
  id: 'headers', label: '헤더 (이름: 값 줄바꿈)', placeholder: 'Content-Type: application/json\nX-Api-Key: {{ key@secret }}',
  toText: (rows) => headersToRaw(rows),
  fromText: (text, prev) => {
    const warnings: ParseWarning[] = []
    const rows: Array<Omit<KvRow, 'id'>> = []
    text.split(/\r?\n/).forEach((raw, idx) => {
      const l = raw.trim()
      if (l === '') return
      const i = l.indexOf(':')
      const key = i > 0 ? l.slice(0, i).trim() : ''
      if (!key) { warnings.push({ line: idx + 1, text: raw, reason: '"이름: 값" 형식이 아닙니다' }); return }
      rows.push({ key, value: l.slice(i + 1).trim() })
    })
    return { rows: reuseIds<KvRow>(rows, prev), warnings }
  },
}
```

- [ ] **Step 5: 테스트 통과 · tsc**

Run: `npm test` → 전부 PASS. `npx tsc -b` → 0 에러.
(`rawToFields` 가 최상위 객체가 아닐 때 null 을 주므로 `{"a": ` 같은 깨진 입력은 경고 1개로 끝난다. `reuseIds` 제네릭이 `Omit<T,'id'>` 배열을 받는 점에 주의.)

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/bodyConvert.ts frontend/src/lib/textForms.ts frontend/src/lib/textForms.test.ts
git commit -m "feat(frontend): 키-값 텍스트 폼 3종 — JSON bare 토큰 스캐너(타입 승계)·urlencoded percent 대칭·헤더 부분 허용"
```

---

### Task 4: `FieldTextToggle` 공용 컴포넌트

**Files:**
- Create: `frontend/src/components/FieldTextToggle.tsx`

**Interfaces:**
- Consumes: `TextForm<T>`, `ParseWarning`(Task 2).
- Produces:
  ```tsx
  export function FieldTextToggle<T>(props: {
    form: TextForm<T>; rows: T[]; onChange: (rows: T[]) => void
    children: React.ReactNode            // 필드 UI(모드 'fields' 일 때 표시)
    title?: React.ReactNode              // 헤더 왼쪽(라벨)
    extras?: React.ReactNode             // 헤더 오른쪽 버튼들(📋 붙여넣기·+ 필드 등) — 두 모드 모두 표시
    readOnly?: boolean
    mode?: 'fields' | 'text'; onModeChange?: (m: 'fields' | 'text') => void   // 제어형(생략 시 내부 상태)
    summary?: (rows: T[]) => React.ReactNode   // 텍스트 모드 아래 라이브 요약(총 바이트 등)
    ariaLabel?: string
  }): JSX.Element
  ```
  동작: 텍스트 모드 진입 시 `form.toText(rows)` 로 버퍼 생성 → 타이핑 300ms 디바운스로 `form.fromText(buf, rows)` → `onChange(rows)` + 경고 표시 → 필드 모드 복귀 시 즉시 파싱 1회. 외부에서 rows 가 바뀌면(붙여넣기 적용 등) 자기가 마지막으로 emit 한 rows 가 아닐 때만 버퍼를 다시 만든다.

- [ ] **Step 1: 구현**

`frontend/src/components/FieldTextToggle.tsx`:
```tsx
import type { CSSProperties, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { ParseWarning, TextForm } from '../lib/textForms'

/**
 * [필드 | 텍스트] 공용 토글 — 어떤 필드 표든 TextForm 하나로 텍스트 보기를 얻는다.
 * 전환할 때마다 실제 변환(toText/fromText). 텍스트 편집은 300ms 디바운스로 필드에 반영되고, 실패 줄은 경고로 남는다(텍스트는 보존).
 */
export function FieldTextToggle<T>({ form, rows, onChange, children, title, extras, readOnly, mode: modeProp, onModeChange, summary, ariaLabel }: {
  form: TextForm<T>; rows: T[]; onChange: (rows: T[]) => void
  children: ReactNode; title?: ReactNode; extras?: ReactNode; readOnly?: boolean
  mode?: 'fields' | 'text'; onModeChange?: (m: 'fields' | 'text') => void
  summary?: (rows: T[]) => ReactNode; ariaLabel?: string
}) {
  const [modeState, setModeState] = useState<'fields' | 'text'>('fields')
  const mode = modeProp ?? modeState
  const setMode = (m: 'fields' | 'text') => { onModeChange?.(m); if (modeProp === undefined) setModeState(m) }
  const [buf, setBuf] = useState('')
  const [warnings, setWarnings] = useState<ParseWarning[]>([])
  const lastEmitted = useRef<T[] | null>(null)
  const timer = useRef<number | null>(null)

  // 텍스트 모드 진입/외부 변경 시 버퍼 재생성(내가 emit 한 rows 면 건너뜀 — 커서 점프 방지)
  useEffect(() => {
    if (mode !== 'text') return
    if (lastEmitted.current === rows) return
    setBuf(form.toText(rows)); setWarnings([])
  }, [mode, rows, form])

  const apply = (text: string) => {
    const r = form.fromText(text, rows)
    setWarnings(r.warnings)
    lastEmitted.current = r.rows
    onChange(r.rows)
  }
  const onText = (text: string) => {
    setBuf(text)
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => apply(text), 300)
  }
  const toFields = () => {
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null }
    apply(buf)
    setMode('fields')
  }
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current) }, [])

  return (
    <div>
      <div style={head}>
        {title !== undefined && <span style={{ minWidth: 0 }}>{title}</span>}
        <div style={seg} role="group" aria-label={ariaLabel ? `${ariaLabel} 보기` : '보기 전환'}>
          <button type="button" onClick={toFields} style={segBtn(mode === 'fields')} aria-pressed={mode === 'fields'}>필드</button>
          <button type="button" onClick={() => setMode('text')} style={segBtn(mode === 'text')} aria-pressed={mode === 'text'} title={form.label}>텍스트</button>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>{extras}</div>
      </div>
      {mode === 'fields' ? children : (
        <div>
          <textarea
            aria-label={ariaLabel ? `${ariaLabel} 텍스트` : '텍스트'}
            value={buf} readOnly={readOnly} spellCheck={false}
            placeholder={form.placeholder}
            onChange={(e) => onText(e.target.value)}
            style={ta}
            rows={Math.max(4, Math.min(16, buf.split('\n').length + 1))}
          />
          <div style={{ fontSize: 11, color: 'var(--fl-text-muted)', marginTop: 4, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <span>{form.label} · 300ms 뒤 필드에 반영</span>
            {summary && <span>{summary(rows)}</span>}
          </div>
          {warnings.length > 0 && (
            <ul style={warnList} role="alert">
              {warnings.map((w, i) => <li key={i}><b>{w.line}행</b> {w.reason} — <code style={{ opacity: .8 }}>{w.text.slice(0, 60)}</code></li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

const head: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }
const seg: CSSProperties = { display: 'inline-flex', gap: 2, background: 'var(--fl-surface-2)', borderRadius: 7, padding: 2, flexShrink: 0 }
function segBtn(active: boolean): CSSProperties {
  return { padding: '4px 10px', border: 'none', borderRadius: 5, fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
    background: active ? 'var(--fl-surface)' : 'transparent', color: active ? 'var(--fl-primary)' : 'var(--fl-text-muted)', boxShadow: active ? 'var(--fl-shadow)' : 'none' }
}
const ta: CSSProperties = { width: '100%', boxSizing: 'border-box', fontFamily: 'var(--fl-font-mono)', fontSize: 12, lineHeight: 1.5, padding: '8px 10px', resize: 'vertical', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)' }
const warnList: CSSProperties = { margin: '6px 0 0', paddingLeft: 18, fontSize: 11.5, color: 'var(--fl-put, #f5a623)' }
```

- [ ] **Step 2: tsc·lint**

Run (in `frontend/`): `npx tsc -b && npm run lint` → 0 에러.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/FieldTextToggle.tsx
git commit -m "feat(frontend): FieldTextToggle — 어떤 필드 표든 TextForm 으로 [필드|텍스트] 전환(디바운스 반영·줄 단위 경고)"
```

---

### Task 5: `TcpLayoutPaste` — 📋 정의서 붙여넣기 / ⧉ 텍스트 복사 (샘플 전문 대조)

**Files:**
- Create: `frontend/src/components/TcpLayoutPaste.tsx`
- Create: `frontend/src/lib/tcpSample.ts` + `frontend/src/lib/tcpSample.test.ts`

**Interfaces:**
- Consumes: `parseTcpLayout/tcpLayoutToText/LayoutRow/LayoutMode`(Task 2), `mocksApi.tcpPreview`(client.ts:189), `Modal`(`components/Modal.tsx` — `<Modal onClose ariaLabel width>`), `toast`.
- Produces:
  ```tsx
  export function TcpLayoutPasteButtons(props: { mode: LayoutMode; rows: LayoutRow[]; encoding: string; prefixLength: number; prefixIncludesSelf: boolean; onApply: (rows: LayoutRow[], how: 'replace' | 'append') => void; readOnly?: boolean; compact?: boolean }): JSX.Element
  // lib/tcpSample.ts
  export function detectPrefix(sample: string, prefixLength: number): { kind: 'none' | 'excl' | 'incl' | 'mismatch'; declared: number | null; message: string }
  ```
  `detectPrefix`: 샘플 앞 N자리가 숫자면 declared 로 읽고 `declared === sample.length - N` → 'excl'(자기 미포함), `=== sample.length` → 'incl', 아니면 'mismatch'; N 자리가 숫자가 아니거나 N=0 → 'none'. (문자 수 기준 — 한글 샘플은 바이트가 달라 안내 문구에 "ASCII 샘플 기준" 명시.)

- [ ] **Step 1: 실패하는 테스트**

`frontend/src/lib/tcpSample.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { detectPrefix } from './tcpSample'

describe('detectPrefix', () => {
  it('앞 4자리 = 본문 길이 → 자기 미포함', () => expect(detectPrefix('001402001234567890', 4).kind).toBe('excl'))
  it('앞 4자리 = 전체 길이 → 포함', () => expect(detectPrefix('001802001234567890', 4).kind).toBe('incl'))
  it('불일치', () => expect(detectPrefix('999902001234567890', 4).kind).toBe('mismatch'))
  it('프리픽스 없음/숫자 아님', () => { expect(detectPrefix('02001234', 0).kind).toBe('none'); expect(detectPrefix('AB0012', 4).kind).toBe('none') })
})
```

- [ ] **Step 2: 실행해 실패 확인** — `npm test` → FAIL(모듈 없음).

- [ ] **Step 3: lib 구현**

`frontend/src/lib/tcpSample.ts`:
```ts
/** 샘플 전문(ASCII 기준)의 길이 프리픽스 자기포함 여부를 데이터로 판정 — 붙여넣기 다이얼로그의 개념 안내용. */
export function detectPrefix(sample: string, prefixLength: number): { kind: 'none' | 'excl' | 'incl' | 'mismatch'; declared: number | null; message: string } {
  const s = sample.replace(/\r?\n$/, '')
  if (prefixLength <= 0 || s.length < prefixLength) return { kind: 'none', declared: null, message: '' }
  const head = s.slice(0, prefixLength)
  if (!/^\d+$/.test(head)) return { kind: 'none', declared: null, message: `앞 ${prefixLength}자리가 숫자가 아니라 길이 프리픽스로 보이지 않습니다.` }
  const declared = Number(head)
  const body = s.length - prefixLength
  if (declared === body) return { kind: 'excl', declared, message: `앞 ${prefixLength}자리 "${head}" = 본문 ${body}자 → 프리픽스 자기 미포함(체크 해제)` }
  if (declared === s.length) return { kind: 'incl', declared, message: `앞 ${prefixLength}자리 "${head}" = 전체 ${s.length}자 → 프리픽스 자기 포함(체크)` }
  return { kind: 'mismatch', declared, message: `앞 ${prefixLength}자리 "${head}" 가 본문 ${body}자/전체 ${s.length}자와 다릅니다 — 한글(2바이트)이 있으면 문자 수와 바이트 수가 달라 정상일 수 있습니다.` }
}
```

- [ ] **Step 4: 컴포넌트 구현**

`frontend/src/components/TcpLayoutPaste.tsx`:
```tsx
import type { CSSProperties } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { mocksApi } from '../api/client'
import type { MockTcpPreview } from '../api/types'
import { parseTcpLayout, tcpLayoutToText, type LayoutMode, type LayoutRow, type ParseWarning } from '../lib/textForms'
import { detectPrefix } from '../lib/tcpSample'
import { Modal } from './Modal'
import { toast } from './toast'

const MODE_LABEL: Record<LayoutMode, string> = { request: '요청 필드(값·패딩)', response: '응답 필드', layout: '요청 레이아웃' }

/** 📋 정의서 붙여넣기 + ⧉ 텍스트 복사 — 노드 요청/응답 필드·Mock 레이아웃/응답 필드 4곳이 같은 버튼을 쓴다. */
export function TcpLayoutPasteButtons({ mode, rows, encoding, prefixLength, prefixIncludesSelf, onApply, readOnly, compact }: {
  mode: LayoutMode; rows: LayoutRow[]; encoding: string; prefixLength: number; prefixIncludesSelf: boolean
  onApply: (rows: LayoutRow[], how: 'replace' | 'append') => void; readOnly?: boolean; compact?: boolean
}) {
  const [open, setOpen] = useState(false)
  const copy = () => {
    const text = tcpLayoutToText(rows, mode)
    void navigator.clipboard?.writeText(text).then(() => toast(`${rows.length}개 필드를 텍스트로 복사했습니다 — 노드/Mock 어디든 📋 로 붙여넣기`, 'ok')).catch(() => toast('복사 실패', 'error'))
  }
  return (
    <>
      {!readOnly && <button type="button" style={btn} onClick={() => setOpen(true)} title="엑셀 정의서 행(항목명/길이/타입/기본값) · 한 줄 문법 · 노드/Mock 에서 복사한 텍스트">📋 {compact ? '' : '정의서 '}붙여넣기</button>}
      <button type="button" style={btn} onClick={copy} disabled={rows.length === 0} title="현재 필드를 텍스트로 복사">⧉ {compact ? '' : '텍스트 '}복사</button>
      {open && <PasteDialog mode={mode} prev={rows} encoding={encoding} prefixLength={prefixLength} prefixIncludesSelf={prefixIncludesSelf} onClose={() => setOpen(false)} onApply={(r, how) => { onApply(r, how); setOpen(false) }} />}
    </>
  )
}

function PasteDialog({ mode, prev, encoding, prefixLength, prefixIncludesSelf, onClose, onApply }: {
  mode: LayoutMode; prev: LayoutRow[]; encoding: string; prefixLength: number; prefixIncludesSelf: boolean
  onClose: () => void; onApply: (rows: LayoutRow[], how: 'replace' | 'append') => void
}) {
  const [text, setText] = useState('')
  const [sample, setSample] = useState('')
  const [how, setHow] = useState<'replace' | 'append'>(prev.length ? 'replace' : 'append')
  const parsed = useMemo(() => parseTcpLayout(text, mode, how === 'replace' ? prev : []), [text, mode, prev, how])
  const total = parsed.rows.reduce((a, r) => a + (r.length ?? 0), 0)
  const [preview, setPreview] = useState<MockTcpPreview | null>(null)
  const [prevErr, setPrevErr] = useState<string | null>(null)
  const prefix = useMemo(() => detectPrefix(sample, prefixLength), [sample, prefixLength])

  // 샘플 전문 대조 — 기존 tcp-preview 에 일회용 spec(프리픽스 0 = 샘플을 본문으로) 을 실어 레이아웃대로 잘라 본다(저장·소켓 없음)
  useEffect(() => {
    if (!sample.trim() || parsed.rows.length === 0) { setPreview(null); setPrevErr(null); return }
    const body = prefix.kind === 'excl' || prefix.kind === 'incl' ? sample.slice(prefixLength) : sample
    const t = window.setTimeout(() => {
      mocksApi.tcpPreview({ charset: encoding, prefixLength: 0, prefixIncludesSelf: false, enabled: false, port: 0,
        requestFields: parsed.rows.map((r) => ({ id: r.id, name: r.name, length: r.length, encoding: r.encoding })), rules: [] }, body)
        .then((p) => { setPreview(p); setPrevErr(null) })
        .catch((e) => { setPreview(null); setPrevErr(e instanceof Error ? e.message : String(e)) })
    }, 300)
    return () => window.clearTimeout(t)
  }, [sample, parsed.rows, encoding, prefixLength, prefix.kind])

  const sampleValues = preview?.requestFields ?? []
  const remain = preview ? preview.requestBytes - total : null
  return (
    <Modal onClose={onClose} ariaLabel="정의서 붙여넣기" width={960}>
      <div style={{ padding: 16, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16 }}>
        <div>
          <div style={h}>📋 {MODE_LABEL[mode]} 붙여넣기</div>
          <p style={hint}>엑셀 정의서에서 <b>항목명 · 길이 · 타입(AN/N) · 기본값</b> 열을 복사해 붙여넣거나, 한 줄 문법(<code>이름 길이 종류 [= 값]</code>)으로 적으세요. 길이는 <b>바이트</b>(EUC-KR 한글 2바이트). 타입 N/9/숫자 → 좌측 0 패딩, 나머지 → 우측 공백.</p>
          <textarea aria-label="정의서 텍스트" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} style={{ ...ta, minHeight: 220 }}
            placeholder={'항목명\t길이\t타입\t기본값\n전문코드\t4\tAN\t0200\n계좌번호\t12\tN\n고객명\t10\tK\n\n또는\n전문코드 4 문자 = 0200\n계좌번호 12 숫자 = {{ acct@set1 }}'} />
          <label style={{ ...lbl, marginTop: 10 }}>샘플 전문(선택) — 로그에서 복사한 실제 전문 한 줄</label>
          <input aria-label="샘플 전문" value={sample} onChange={(e) => setSample(e.target.value)} style={{ ...ta, minHeight: 0, fontFamily: 'var(--fl-font-mono)' }} placeholder="001402001234567890" />
          {prefix.message && <p style={{ ...hint, color: prefix.kind === 'mismatch' ? 'var(--fl-put, #f5a623)' : 'var(--fl-ok)' }}>{prefix.message}{(prefix.kind === 'excl') !== !prefixIncludesSelf && prefix.kind !== 'none' && prefix.kind !== 'mismatch' ? ' — 현재 설정과 다릅니다' : ''}</p>}
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={h}>미리보기 <span style={{ fontWeight: 400, color: 'var(--fl-text-muted)' }}>{parsed.rows.length}필드 · 총 {total}B{parsed.headerMapped ? ' · 헤더 열 매핑' : ''}</span></div>
          {parsed.warnings.length > 0 && <ul style={warn} role="alert">{parsed.warnings.map((w: ParseWarning, i) => <li key={i}><b>{w.line}행</b> {w.reason}</li>)}</ul>}
          <div style={{ maxHeight: 300, overflow: 'auto', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'var(--fl-font-mono)' }}>
              <thead><tr style={{ color: 'var(--fl-text-muted)' }}><th style={th}>@</th><th style={th}>이름</th><th style={th}>길이</th>{mode === 'request' && <><th style={th}>패딩</th><th style={th}>값</th></>}{mode === 'response' && <th style={th}>종류</th>}{sample && <th style={th}>샘플</th>}</tr></thead>
              <tbody>
                {parsed.rows.map((r, i) => {
                  const off = parsed.rows.slice(0, i).reduce((a, x) => a + (x.length ?? 0), 0)
                  return (
                    <tr key={r.id}><td style={td}>{off}</td><td style={td}>{r.name}</td><td style={td}>{r.length}</td>
                      {mode === 'request' && <><td style={td}>{r.pad === 'left' ? '←' : '→'}{JSON.stringify(r.padChar ?? ' ')}</td><td style={td}>{r.value ?? ''}</td></>}
                      {mode === 'response' && <td style={td}>{r.type === 'number' ? '숫자' : r.type === 'string' ? '문자' : ''}</td>}
                      {sample && <td style={td}>{sampleValues[i] ? JSON.stringify(sampleValues[i].value) : ''}</td>}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {preview && <p style={{ ...hint, color: remain === 0 ? 'var(--fl-ok)' : 'var(--fl-put, #f5a623)' }}>샘플 {preview.requestBytes}B vs 레이아웃 {total}B {remain === 0 ? '✓ 일치' : remain! > 0 ? `✗ 샘플이 ${remain}B 남음(필드가 모자람)` : `✗ 레이아웃이 ${-remain!}B 더 김`}</p>}
          {prevErr && <p style={{ ...hint, color: 'var(--fl-fail)' }}>샘플 대조 실패: {prevErr}</p>}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
            <label style={lbl}><input type="radio" checked={how === 'replace'} onChange={() => setHow('replace')} /> 기존 {prev.length}개 교체</label>
            <label style={lbl}><input type="radio" checked={how === 'append'} onChange={() => setHow('append')} /> 아래에 추가</label>
            <span style={{ marginLeft: 'auto' }} />
            <button type="button" style={btn} onClick={onClose}>취소</button>
            <button type="button" style={{ ...btn, background: 'var(--fl-primary)', color: '#fff', borderColor: 'var(--fl-primary)' }} disabled={parsed.rows.length === 0} onClick={() => onApply(parsed.rows, how)}>적용 ({parsed.rows.length}개)</button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

const btn: CSSProperties = { fontSize: 11.5, padding: '4px 9px', border: '1px solid var(--fl-border)', borderRadius: 6, background: 'var(--fl-surface)', color: 'var(--fl-text)', cursor: 'pointer' }
const h: CSSProperties = { fontSize: 13.5, fontWeight: 800, marginBottom: 6 }
const hint: CSSProperties = { fontSize: 12, color: 'var(--fl-text-muted)', margin: '4px 0 8px', lineHeight: 1.5 }
const lbl: CSSProperties = { fontSize: 12, display: 'flex', alignItems: 'center', gap: 5 }
const ta: CSSProperties = { width: '100%', boxSizing: 'border-box', fontFamily: 'var(--fl-font-mono)', fontSize: 12, padding: '8px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', resize: 'vertical' }
const warn: CSSProperties = { margin: '0 0 6px', paddingLeft: 18, fontSize: 11.5, color: 'var(--fl-put, #f5a623)' }
const th: CSSProperties = { textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid var(--fl-border)', fontWeight: 600 }
const td: CSSProperties = { padding: '3px 8px', borderBottom: '1px solid var(--fl-border)', whiteSpace: 'nowrap' }
```
(`Modal` 의 props 이름은 `frontend/src/components/Modal.tsx` 를 열어 확인하고 맞춘다 — MockServerEditor 는 `<Modal onClose ariaLabel width>` 로 쓴다.)

- [ ] **Step 5: 테스트·tsc·lint** — `npm test` PASS, `npx tsc -b`, `npm run lint` 0 에러.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/TcpLayoutPaste.tsx frontend/src/lib/tcpSample.ts frontend/src/lib/tcpSample.test.ts
git commit -m "feat(frontend): 정의서 붙여넣기 다이얼로그 — TSV/DSL → 필드 표 미리보기, 샘플 전문 대조(tcp-preview), 프리픽스 자기포함 판정, 텍스트 복사"
```

---

### Task 6: PropertyPanel 통합 — TCP 요청/응답 필드에 토글·붙여넣기·인코딩·trim/type, HTTP 토글 손실 수정

**Files:**
- Modify: `frontend/src/panels/PropertyPanel.tsx` (`switchBodyMode/switchKvRaw/switchFormRaw` ≈479-545, TCP 블록 ≈1393-1420, `TcpReqEditor/TcpRespEditor` ≈1948-2014)

**Interfaces:**
- Consumes: `FieldTextToggle`, `TcpLayoutPasteButtons`, `tcpLayoutForm`, `jsonBodyForm/kvUrlForm/headersForm`, `KvRow`, `isTokenizable`.

- [ ] **Step 1: HTTP 토글을 폼으로 교체(+bound 가드)**

`switchBodyMode` 전체를 다음으로 교체:
```ts
  const switchBodyMode = (raw: boolean) => {
    if (raw === !!node.jsonRaw) return
    const bt = node.bodyType ?? 'json'
    const form = bt === 'json' ? jsonBodyForm : kvUrlForm
    const bodyFields = node.fields?.body ?? []
    if (raw) {
      const stuck = bodyFields.filter((f) => f.bound && !isTokenizable(f.bound)).map((f) => f.key).filter(Boolean)
      if (stuck.length) { setBodyConvNote(`구조적 바인딩(토큰화 불가) 필드가 있어 Raw 로 바꿀 수 없습니다: ${stuck.join(', ')} — 그 필드의 바인딩을 { } 토큰으로 다시 넣으세요.`); return }
      const rows: KvRow[] = bodyFields.map((f) => ({ id: f.id, key: f.key ?? '', value: f.bound ? bindingToToken(f.bound) : (f.value ?? ''), type: f.type }))
      setBodyConvNote(null)
      update(id, { jsonRaw: true, rawBody: form.toText(rows) })
    } else {
      const prevRows: KvRow[] = bodyFields.map((f) => ({ id: f.id, key: f.key ?? '', value: f.value ?? '', type: f.type }))
      const r = form.fromText(node.rawBody ?? '', prevRows)
      if (r.rows.length === 0 && r.warnings.length) { setBodyConvNote(`Raw 본문을 필드로 변환하지 못했어요: ${r.warnings[0].reason}. 원문은 Raw 에 그대로 있습니다.`); update(id, { jsonRaw: false }); return }
      setBodyConvNote(r.warnings.length ? r.warnings.map((w) => `${w.line}행: ${w.reason}`).join(' · ') : null)
      const body: NodeField[] = r.rows.map((kv) => ({ id: kv.id, key: kv.key, value: kv.value, type: kv.type }))
      update(id, { jsonRaw: false, fields: { params: fields.params ?? [], headers: fields.headers ?? [], body } })
    }
  }
```
`switchKvRaw` 에서 `fieldsToRaw(rows, 'urlencoded')` → `kvUrlForm.toText(rows)`, `headersToRaw(rows)` → `headersForm.toText(rows)`, 파싱 분기는 `const r = t === 'params' ? kvUrlForm.fromText(rawText, prevRows) : headersForm.fromText(rawText, prevRows)` 로 바꾸고 `parsed === null` 분기를 `r.rows.length === 0 && r.warnings.length` 로, 성공 시 `next = r.rows.map((kv) => ({ id: kv.id, key: kv.key, value: kv.value }))`, 경고는 `setBodyConvNote(...)` 로 표시. rows 생성 시 `id: f.id` 를 포함(KvRow). `switchFormRaw` 도 `kvUrlForm` 으로 동일 치환. bound 가드는 세 함수 모두 적용(위 `stuck` 블록 복사).
import 추가: `import { headersForm, jsonBodyForm, kvUrlForm, tcpLayoutForm, type KvRow, type LayoutRow } from '../lib/textForms'`, `import { FieldTextToggle } from '../components/FieldTextToggle'`, `import { TcpLayoutPasteButtons } from '../components/TcpLayoutPaste'`. 더 이상 안 쓰는 `fieldsToRaw/rawToFields/headersToRaw/rawToHeaders` import 는 제거(lint).

- [ ] **Step 2: TcpReqEditor/TcpRespEditor 에 인코딩·trim/type 열**

`TcpReqEditor` 행의 패딩문자 input 뒤에 추가:
```tsx
            <select style={{ ...field, width: 78 }} value={f.encoding ?? ''} title="필드 인코딩(비면 노드 인코딩)" onChange={(e) => upd(f.id, { encoding: e.target.value || undefined })}>
              <option value="">(노드)</option>{['EUC-KR', 'MS949', 'UTF-8', 'US-ASCII'].map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
```
`TcpRespEditor` 행의 길이 input 뒤에 추가:
```tsx
          <select style={{ ...field, width: 64 }} value={f.type ?? 'string'} title="출력 타입 — 숫자면 선행 0 제거 후 숫자 원형(조건식 숫자 비교)" onChange={(e) => upd(f.id, { type: e.target.value as 'string' | 'number' })}>
            <option value="string">문자</option><option value="number">숫자</option>
          </select>
          <label title="슬라이스 후 패딩 제거(문자=후행 공백, 숫자=선행 0·공백)" style={{ fontSize: 11, color: 'var(--fl-text-muted)', display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0 }}>
            <input type="checkbox" checked={!!f.trim} onChange={(e) => upd(f.id, { trim: e.target.checked })} />trim
          </label>
          <select style={{ ...field, width: 78 }} value={f.encoding ?? ''} title="필드 인코딩(비면 노드 인코딩)" onChange={(e) => upd(f.id, { encoding: e.target.value || undefined })}>
            <option value="">(노드)</option>{['EUC-KR', 'MS949', 'UTF-8', 'US-ASCII'].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
```
`+ 응답 필드` 버튼의 새 행: `{ id: newId(), name: '', length: 10, trim: true, type: 'string' }`.

- [ ] **Step 3: TCP 블록에 토글·붙여넣기 감싸기**

`reqCol` 의 `<label style={label}>요청 필드 …</label>` + `<TcpReqEditor …/>` 두 줄을 다음으로 교체:
```tsx
            <FieldTextToggle<LayoutRow>
              form={tcpLayoutForm('request')} rows={(node.tcpRequest ?? []) as LayoutRow[]} ariaLabel="요청 필드"
              onChange={(r) => update(id, { tcpRequest: r as TcpField[] })}
              title={<label style={{ ...label, margin: 0 }}>요청 필드 (고정길이 · 위→아래 순서로 연결)</label>}
              summary={(r) => `총 ${r.reduce((a, f) => a + (f.length ?? 0), 0)} 바이트`}
              extras={<TcpLayoutPasteButtons mode="request" rows={(node.tcpRequest ?? []) as LayoutRow[]} encoding={node.tcpEncoding ?? 'EUC-KR'} prefixLength={node.tcpPrefixLength ?? 0} prefixIncludesSelf={!!node.tcpPrefixIncludesSelf} compact readOnly={!canEdit}
                onApply={(rows, how) => update(id, { tcpRequest: (how === 'replace' ? rows : [...(node.tcpRequest ?? []), ...rows]) as TcpField[] })} />}
            >
              <TcpReqEditor fields={node.tcpRequest ?? []} sources={sources} sourceType={sourceType} onChange={(r) => update(id, { tcpRequest: r })} />
            </FieldTextToggle>
```
`respCol` 의 `<label style={label}>응답 필드 …</label>` + `<TcpRespEditor …/>` 블록을 교체(출력 키 동기화는 유지, 타입도 반영):
```tsx
            {(() => {
              const syncResp = (r: TcpRespField[]) => update(id, { tcpResponse: r, outputs: r.filter((f) => f.name && f.name.trim()).map((f) => ({ key: f.name!, type: f.type === 'number' ? 'number' : 'string' })) })
              return (
                <FieldTextToggle<LayoutRow>
                  form={tcpLayoutForm('response')} rows={(node.tcpResponse ?? []) as LayoutRow[]} ariaLabel="응답 필드"
                  onChange={(r) => syncResp(r as TcpRespField[])}
                  title={<label style={{ ...label, margin: 0 }}>응답 필드 (고정길이 → 출력)</label>}
                  summary={(r) => `총 ${r.reduce((a, f) => a + (f.length ?? 0), 0)} 바이트`}
                  extras={<TcpLayoutPasteButtons mode="response" rows={(node.tcpResponse ?? []) as LayoutRow[]} encoding={node.tcpEncoding ?? 'EUC-KR'} prefixLength={node.tcpPrefixLength ?? 0} prefixIncludesSelf={!!node.tcpPrefixIncludesSelf} compact readOnly={!canEdit}
                    onApply={(rows, how) => syncResp((how === 'replace' ? rows : [...(node.tcpResponse ?? []), ...rows]) as TcpRespField[])} />}
                >
                  <TcpRespEditor fields={node.tcpResponse ?? []} onChange={syncResp} />
                </FieldTextToggle>
              )
            })()}
```
(`TcpField`/`TcpRespField` 는 `LayoutRow` 의 구조적 부분집합이라 캐스팅이 안전하다 — `LayoutRow.bound` 는 `Binding|null`, TcpField 와 동일.)

- [ ] **Step 4: tsc·lint·build**

Run: `npx tsc -b && npm run lint && npm run build` → 0 에러.

- [ ] **Step 5: 수동 확인(브라우저)**

Run: `npm run dev`(5173, 백엔드 18080 필요 — 사용자의 orca 인스턴스가 떠 있으면 그대로 사용, 아니면 `scripts\start.ps1`) → 워크플로에 TCP 노드 추가 → 요청 필드 [텍스트] → 텍스트에 `계좌번호 12 숫자 = 1234` 한 줄 추가 → [필드] → 행이 생기고 ←/0 패딩 확인 → 📋 붙여넣기에 TSV 3행 붙여넣기 → 미리보기 표 → 적용 → 응답 필드 [텍스트]에 `잔액 12 숫자` → 필드에서 숫자/trim 체크 확인 → HTTP 노드 본문 필드 `amount`(number, `{{ x@y }}`) → Raw 에 따옴표 없이 → 필드로 돌아오면 number 유지.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/panels/PropertyPanel.tsx
git commit -m "feat(editor): TCP 노드 요청/응답 필드 [필드|텍스트]·정의서 붙여넣기·필드 인코딩·응답 trim/타입, HTTP 본문/쿼리/헤더 토글을 텍스트 폼으로(bound 가드·bare 토큰 타입 승계·percent 대칭)"
```

---

### Task 7: MockTcpEditor 통합 — 레이아웃/응답 필드 토글·붙여넣기, 파괴적 텍스트 전환을 3모드로

**Files:**
- Modify: `frontend/src/components/MockTcpEditor.tsx` (`TcpLayoutPanel` ≈85-130, `TcpRuleDetail` ≈133-250)

- [ ] **Step 1: TcpLayoutPanel**

import 추가: `import { FieldTextToggle } from './FieldTextToggle'`, `import { TcpLayoutPasteButtons } from './TcpLayoutPaste'`, `import { tcpLayoutForm, type LayoutRow } from '../lib/textForms'`.
`TcpLayoutPanel` 의 `<div style={{ display: 'grid', gap: 4, marginTop: 10 }}>…</div>` 와 `+ 요청 필드` 버튼을 다음으로 감싼다:
```tsx
      <div style={{ marginTop: 10 }}>
        <FieldTextToggle<LayoutRow> form={tcpLayoutForm('layout')} rows={layout as LayoutRow[]} onChange={(r) => setLayout(r as MockTcpReqField[])} readOnly={readOnly} ariaLabel="요청 레이아웃"
          summary={(r) => `총 ${r.reduce((a, f) => a + (f.length ?? 0), 0)}B`}
          extras={<TcpLayoutPasteButtons mode="layout" rows={layout as LayoutRow[]} encoding={tcp.charset ?? 'EUC-KR'} prefixLength={tcp.prefixLength ?? 4} prefixIncludesSelf={!!tcp.prefixIncludesSelf} readOnly={readOnly}
            onApply={(rows, how) => setLayout((how === 'replace' ? rows : [...layout, ...rows]) as MockTcpReqField[])} />}>
          {/* 기존 grid(행 목록) + 빈 상태 문구 + '+ 요청 필드' 버튼을 그대로 children 으로 */}
          …
        </FieldTextToggle>
      </div>
```

- [ ] **Step 2: TcpRuleDetail — [필드 | 텍스트 | 템플릿(고급)]**

`mode` 상태를 `'fields' | 'text' | 'template'` 로: 초기값 `fields.length > 0 ? 'fields' : 'template'`. `switchMode` 를 다음으로 교체:
```tsx
  const [confirmTpl, setConfirmTpl] = useState(false)
  const switchMode = (m: 'fields' | 'text' | 'template') => {
    if (m === 'template') {
      if (fields.length > 0 && !confirmTpl) { setConfirmTpl(true); return } // 2단계 확인 — 필드 정의를 버림
      setConfirmTpl(false); setMode('template'); onChange({ responseFields: [] }); return
    }
    setConfirmTpl(false)
    if (fields.length === 0) onChange({ responseFields: [{ id: newId(), name: '응답코드', length: 4, value: '0000', pad: 'right', padChar: ' ' }] })
    setMode(m)
  }
```
세그먼트 버튼 배열을 `(['fields', 'text', 'template'] as const)` 로, 라벨 `{m === 'fields' ? '필드' : m === 'text' ? '텍스트' : '템플릿(고급)'}`. 세그먼트 옆에 확인 UI:
```tsx
          {confirmTpl && <span style={{ fontSize: 11.5, color: 'var(--fl-put, #f5a623)' }}>필드 {fields.length}개 정의를 버리고 평문 템플릿으로 바꿉니다 <button style={miniBtn} onClick={() => switchMode('template')}>확인</button> <button style={miniBtn} onClick={() => setConfirmTpl(false)}>취소</button></span>}
```
본문 렌더: `mode === 'template'` 이면 기존 textarea(`r.response`). 그 외엔 기존 필드 grid 전체를 `FieldTextToggle` 로 감싸고 `mode={mode === 'text' ? 'text' : 'fields'} onModeChange={(m) => setMode(m)}` 제어형으로 연결(자체 세그먼트가 상단 3모드 세그먼트와 중복되지 않게 `title`/세그먼트는 FieldTextToggle 것을 숨기지 않고, 상단 3모드 세그먼트를 제거하고 FieldTextToggle 의 `extras` 에 `템플릿(고급)` 버튼 하나만 둔다):
```tsx
        {mode === 'template' ? (
          <div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
              <span style={{ fontSize: 11.5, color: 'var(--fl-text-muted)' }}>평문 템플릿 — 길이를 직접 맞춰야 합니다(필드 모드 권장)</span>
              {!readOnly && <button style={miniBtn} onClick={() => switchMode('fields')}>필드 모드로</button>}
            </div>
            <textarea …기존 그대로… />
          </div>
        ) : (
          <div style={{ marginTop: 8 }}>
            <FieldTextToggle<LayoutRow> form={tcpLayoutForm('request')} rows={fields as LayoutRow[]} onChange={(rows) => onChange({ responseFields: rows as MockTcpRespField[] })} readOnly={readOnly} ariaLabel="응답 필드"
              mode={mode === 'text' ? 'text' : 'fields'} onModeChange={(m) => switchMode(m)}
              summary={(r) => `본문 ${r.reduce((a, f) => a + (f.length ?? 0), 0)}B`}
              extras={<>
                <TcpLayoutPasteButtons mode="request" rows={fields as LayoutRow[]} encoding={tcpCharset} prefixLength={0} prefixIncludesSelf={false} readOnly={readOnly} compact
                  onApply={(rows, how) => onChange({ responseFields: (how === 'replace' ? rows : [...fields, ...rows]) as MockTcpRespField[] })} />
                {!readOnly && <button style={miniBtn} onClick={() => switchMode('template')} title="responseFields 없이 평문 템플릿으로(고급)">템플릿(고급)</button>}
                {confirmTpl && <span style={{ fontSize: 11.5, color: 'var(--fl-put, #f5a623)' }}>필드 {fields.length}개를 버립니다 <button style={miniBtn} onClick={() => switchMode('template')}>확인</button> <button style={miniBtn} onClick={() => setConfirmTpl(false)}>취소</button></span>}
              </>}>
              {/* 기존 필드 grid + '+ 문자 필드/+ 숫자 필드' + ◈ 안내 그대로 */}
            </FieldTextToggle>
          </div>
        )}
```
`TcpRuleDetail` props 에 `tcpCharset: string` 을 추가하고 MockServerEditor 호출부(≈405행)에 `tcpCharset={tcp.charset ?? 'EUC-KR'}` 를 넘긴다. 기존 `⬆ 응답 전문` 제목 줄의 힌트(`값: {{ 필드@req }} …`)는 유지.

- [ ] **Step 3: tsc·lint·build·수동 확인**

`npx tsc -b && npm run lint && npm run build`. 브라우저: TCP Mock 편집기 → 요청 레이아웃 [텍스트] 편집 → 규칙 응답 [텍스트] → 필드 복귀 시 값·패딩 유지 → 템플릿(고급) 2단계 확인 → 📋 붙여넣기.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/MockTcpEditor.tsx frontend/src/routes/MockServerEditor.tsx
git commit -m "feat(mock): TCP 요청 레이아웃·규칙 응답 필드 [필드|텍스트]+정의서 붙여넣기, 파괴적 텍스트 전환을 [필드|텍스트|템플릿(고급)] 2단계 확인으로"
```

---

## Part B — 거울 생성 · 기본값 · 단일 실행 override · 응답 trim/type

### Task 8: `lib/tcpMirror.ts` — 노드 ⇄ Mock 변환 + 정합성 diff

**Files:**
- Create: `frontend/src/lib/tcpMirror.ts`, `frontend/src/lib/tcpMirror.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function nodeToMockTcp(node: GraphNode, opts?: { port?: number }): MockTcpSpec
  //  requestFields ← node.tcpRequest(name/length/encoding) · rules[0].responseFields ← node.tcpResponse(name/length/encoding, value '', pad right ' ') · charset/prefix ← 노드
  export function mockTcpToNode(tcp: MockTcpSpec, rule: MockTcpRuleSpec | null, host: string): Partial<GraphNode>
  //  tcpHost/tcpPort/tcpEncoding/tcpPrefixLength/tcpPrefixIncludesSelf · tcpRequest ← requestFields(value '' pad right ' ') · tcpResponse ← rule.responseFields(name/length/encoding, trim true, type: pad left&'0' → number) · outputs 동기
  export interface MirrorDiff { field: string; node: string; mock: string }
  export function mirrorDiff(node: GraphNode, tcp: MockTcpSpec, rule: MockTcpRuleSpec | null): MirrorDiff[]
  //  포트·인코딩·프리픽스 길이·자기포함·요청 길이 합·응답 필드 개수/각 길이(이름 포함) 불일치 목록(빈 배열 = 일치)
  ```

- [ ] **Step 1: 실패하는 테스트**

`frontend/src/lib/tcpMirror.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import type { GraphNode, MockTcpSpec } from '../api/types'
import { mirrorDiff, mockTcpToNode, nodeToMockTcp } from './tcpMirror'

const tcp: MockTcpSpec = { enabled: true, port: 9091, charset: 'EUC-KR', prefixLength: 4, prefixIncludesSelf: false,
  requestFields: [{ id: 'q1', name: '전문코드', length: 4 }, { id: 'q2', name: '계좌번호', length: 10 }],
  rules: [{ id: 't1', contains: '', when: [], response: '', responseFields: [
    { id: 'f1', name: '응답코드', length: 4, value: '0000' }, { id: 'f2', name: '계좌번호', length: 10, value: '{{req.계좌번호}}' },
    { id: 'f3', name: '잔액', length: 12, value: '1500000', pad: 'left', padChar: '0' }, { id: 'f4', name: '고객명', length: 10, value: '홍길동' } ] }] }

describe('tcpMirror', () => {
  it('Mock → 노드: 연결·프리픽스·요청/응답 필드·출력 키', () => {
    const p = mockTcpToNode(tcp, tcp.rules![0], 'localhost')
    expect(p).toMatchObject({ tcpHost: 'localhost', tcpPort: 9091, tcpEncoding: 'EUC-KR', tcpPrefixLength: 4, tcpPrefixIncludesSelf: false })
    expect(p.tcpRequest!.map((f) => [f.name, f.length, f.pad, f.padChar, f.value])).toEqual([['전문코드', 4, 'right', ' ', ''], ['계좌번호', 10, 'right', ' ', '']])
    expect(p.tcpResponse!.map((f) => [f.name, f.length, f.trim, f.type])).toEqual([['응답코드', 4, true, 'string'], ['계좌번호', 10, true, 'string'], ['잔액', 12, true, 'number'], ['고객명', 10, true, 'string']])
    expect(p.outputs).toEqual([{ key: '응답코드', type: 'string' }, { key: '계좌번호', type: 'string' }, { key: '잔액', type: 'number' }, { key: '고객명', type: 'string' }])
  })
  it('노드 → Mock → 노드 왕복(이름·길이 기준) + diff 0', () => {
    const node = { id: 'n', name: 'x', type: 'tcp', cat: 'tcp', x: 0, y: 0, ...mockTcpToNode(tcp, tcp.rules![0], 'localhost') } as GraphNode
    const m = nodeToMockTcp(node)
    expect(m.requestFields!.map((f) => [f.name, f.length])).toEqual([['전문코드', 4], ['계좌번호', 10]])
    expect(m.rules![0].responseFields!.map((f) => [f.name, f.length, f.pad, f.padChar])).toEqual([['응답코드', 4, 'right', ' '], ['계좌번호', 10, 'right', ' '], ['잔액', 12, 'left', '0'], ['고객명', 10, 'right', ' ']])
    expect(mirrorDiff(node, tcp, tcp.rules![0])).toEqual([])
  })
  it('diff: 포트·프리픽스·요청 길이·응답 필드 길이', () => {
    const node = { id: 'n', name: 'x', type: 'tcp', cat: 'tcp', x: 0, y: 0, ...mockTcpToNode(tcp, tcp.rules![0], 'localhost'), tcpPort: 9000, tcpPrefixLength: 0 } as GraphNode
    node.tcpResponse = node.tcpResponse!.map((f, i) => (i === 2 ? { ...f, length: 15 } : f))
    const d = mirrorDiff(node, tcp, tcp.rules![0])
    expect(d.map((x) => x.field)).toEqual(['포트', '프리픽스 길이', '응답 필드 잔액 길이'])
  })
})
```

- [ ] **Step 2: 실행해 실패 확인** — `npm test` → FAIL.

- [ ] **Step 3: 구현**

`frontend/src/lib/tcpMirror.ts`:
```ts
import type { GraphNode, MockTcpReqField, MockTcpRespField, MockTcpRuleSpec, MockTcpSpec, TcpField, TcpRespField } from '../api/types'
import { newId } from './ids'

/**
 * 노드 ⇄ TCP Mock 거울 변환(순수). 노드 요청 필드 ≅ Mock 요청 레이아웃, 노드 응답 필드 ≅ Mock 규칙 응답 필드.
 * 값 템플릿은 양쪽 의미가 달라 생성 시 비운다(노드 {{ x@n }} 은 Mock 에서 의미 없음, Mock {{req.x}} 는 노드에서 의미 없음).
 */
export function nodeToMockTcp(node: GraphNode, opts?: { port?: number }): MockTcpSpec {
  const requestFields: MockTcpReqField[] = (node.tcpRequest ?? []).map((f) => ({ id: newId(), name: f.name ?? '', length: f.length ?? 0, ...(f.encoding ? { encoding: f.encoding } : {}) }))
  const responseFields: MockTcpRespField[] = (node.tcpResponse ?? []).map((f) => ({ id: newId(), name: f.name ?? '', length: f.length ?? 0, value: '',
    pad: f.type === 'number' ? 'left' : 'right', padChar: f.type === 'number' ? '0' : ' ', ...(f.encoding ? { encoding: f.encoding } : {}) }))
  const rule: MockTcpRuleSpec = { id: newId(), contains: '', when: [], response: '', responseFields }
  return { enabled: true, port: opts?.port ?? node.tcpPort ?? 9091, charset: node.tcpEncoding ?? 'EUC-KR',
    prefixLength: node.tcpPrefixLength ?? 0, prefixIncludesSelf: !!node.tcpPrefixIncludesSelf, requestFields, rules: [rule] }
}

export function mockTcpToNode(tcp: MockTcpSpec, rule: MockTcpRuleSpec | null, host: string): Partial<GraphNode> {
  const tcpRequest: TcpField[] = (tcp.requestFields ?? []).map((f) => ({ id: newId(), name: f.name ?? '', length: f.length ?? 0, value: '', pad: 'right', padChar: ' ', ...(f.encoding ? { encoding: f.encoding } : {}) }))
  const tcpResponse: TcpRespField[] = (rule?.responseFields ?? []).map((f) => ({ id: newId(), name: f.name ?? '', length: f.length ?? 0, trim: true,
    type: f.pad === 'left' && (f.padChar ?? ' ') === '0' ? 'number' : 'string', ...(f.encoding ? { encoding: f.encoding } : {}) }))
  return { tcpHost: host, tcpPort: tcp.port ?? 9091, tcpEncoding: tcp.charset ?? 'EUC-KR', tcpPrefixLength: tcp.prefixLength ?? 4, tcpPrefixIncludesSelf: !!tcp.prefixIncludesSelf,
    tcpRequest, tcpResponse, outputs: tcpResponse.filter((f) => f.name).map((f) => ({ key: f.name!, type: f.type === 'number' ? 'number' : 'string' })) }
}

export interface MirrorDiff { field: string; node: string; mock: string }
export function mirrorDiff(node: GraphNode, tcp: MockTcpSpec, rule: MockTcpRuleSpec | null): MirrorDiff[] {
  const out: MirrorDiff[] = []
  const cmp = (field: string, a: unknown, b: unknown) => { if (String(a ?? '') !== String(b ?? '')) out.push({ field, node: String(a ?? ''), mock: String(b ?? '') }) }
  cmp('포트', node.tcpPort ?? 0, tcp.port ?? 0)
  cmp('인코딩', node.tcpEncoding ?? 'EUC-KR', tcp.charset ?? 'EUC-KR')
  cmp('프리픽스 길이', node.tcpPrefixLength ?? 0, tcp.prefixLength ?? 4)
  cmp('프리픽스 자기 포함', !!node.tcpPrefixIncludesSelf, !!tcp.prefixIncludesSelf)
  const sum = (a: Array<{ length?: number }>) => a.reduce((s, f) => s + (f.length ?? 0), 0)
  cmp('요청 길이 합', sum(node.tcpRequest ?? []), sum(tcp.requestFields ?? []))
  const nr = node.tcpResponse ?? [], mr = rule?.responseFields ?? []
  if (nr.length !== mr.length) out.push({ field: '응답 필드 수', node: String(nr.length), mock: String(mr.length) })
  else nr.forEach((f, i) => cmp(`응답 필드 ${f.name || i + 1} 길이`, f.length ?? 0, mr[i].length ?? 0))
  return out
}
```

- [ ] **Step 4: 테스트 통과** — `npm test` PASS, `npx tsc -b` 0.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/tcpMirror.ts frontend/src/lib/tcpMirror.test.ts
git commit -m "feat(frontend): tcpMirror — 노드⇄TCP Mock 거울 변환(요청 레이아웃·응답 필드·연결) + 정합성 diff"
```

---

### Task 9: 새 TCP 노드 기본값 = Mock 시드 (첫 실행이 성공하게)

**Files:**
- Modify: `frontend/src/canvas/nodeFactory.ts:48-56`
- Create: `frontend/src/lib/tcpDefaults.test.ts`

- [ ] **Step 1: 실패하는 테스트**

`frontend/src/lib/tcpDefaults.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { makeNode } from '../canvas/nodeFactory'
import { defaultTcpSpec } from '../components/MockTcpEditor'
import { mirrorDiff } from './tcpMirror'

describe('새 TCP 노드 기본값 = 새 TCP Mock 시드', () => {
  it('포트·프리픽스·레이아웃·응답 필드가 일치(diff 0)', () => {
    const node = makeNode('tcp', 0, 0)
    const tcp = defaultTcpSpec()
    expect(mirrorDiff(node, tcp, tcp.rules![0])).toEqual([])
    expect(node.tcpRequest!.map((f) => [f.name, f.value])).toEqual([['전문코드', '0200'], ['계좌번호', '1234567890']])
    expect(node.tcpResponse!.every((f) => f.trim === true)).toBe(true)
    expect(node.outputs).toEqual([{ key: '응답코드', type: 'string' }, { key: '계좌번호', type: 'string' }, { key: '잔액', type: 'number' }, { key: '고객명', type: 'string' }])
  })
})
```
(`MockTcpEditor.tsx` 는 React 컴포넌트 파일이라 vitest node 환경에서 import 시 `react` 는 문제없지만 `mocksApi`(axios) import 가 딸려온다 — 문제되면 `defaultTcpSpec/defaultTcpRule` 을 새 파일 `frontend/src/lib/tcpDefaults.ts` 로 옮기고 MockTcpEditor 가 re-export 한다.)

- [ ] **Step 2: 실행해 실패 확인** — `npm test` → FAIL(포트 9000 등).

- [ ] **Step 3: nodeFactory 수정**

`case 'tcp':` 반환값을 다음으로:
```ts
    case 'tcp':
      // 새 TCP Mock 시드(잔액조회 전문)와 바이트 단위로 같은 전문 — "그냥 연결"하면 첫 실행이 성공하게(tcpDefaults.test 가 고정)
      return {
        id, name: 'TCP 전문', type: 'tcp', cat: 'tcp', x, y,
        tcpHost: '127.0.0.1', tcpPort: 9091, tcpEncoding: 'EUC-KR', tcpTimeoutMs: 5000,
        tcpPrefixLength: 4, tcpPrefixIncludesSelf: false,
        tcpRequest: [
          { id: newId(), name: '전문코드', length: 4, value: '0200', pad: 'right', padChar: ' ' },
          { id: newId(), name: '계좌번호', length: 10, value: '1234567890', pad: 'right', padChar: ' ' },
        ],
        tcpResponse: [
          { id: newId(), name: '응답코드', length: 4, trim: true, type: 'string' },
          { id: newId(), name: '계좌번호', length: 10, trim: true, type: 'string' },
          { id: newId(), name: '잔액', length: 12, trim: true, type: 'number' },
          { id: newId(), name: '고객명', length: 10, trim: true, type: 'string' },
        ],
        outputs: [{ key: '응답코드', type: 'string' }, { key: '계좌번호', type: 'string' }, { key: '잔액', type: 'number' }, { key: '고객명', type: 'string' }],
      }
```
(기존 반환에 `outputs` 가 있었다면 그 형태를 따른다 — `nodeFactory.ts:48-56` 을 열어 확인.)

- [ ] **Step 4: 테스트 통과** — `npm test` PASS. `npx tsc -b`.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/canvas/nodeFactory.ts frontend/src/lib/tcpDefaults.test.ts frontend/src/lib/tcpDefaults.ts frontend/src/components/MockTcpEditor.tsx
git commit -m "feat(editor): 새 TCP 노드 기본값을 TCP Mock 시드(잔액조회·9091·prefix4)와 일치 — 첫 연결이 성공하도록(테스트로 고정)"
```

---

### Task 10: 단일 실행에 편집 중 노드 override (백엔드 + 프론트)

**Files:**
- Modify: `backend/src/main/kotlin/com/flowlink/execution/dto/RunRequest.kt`
- Modify: `backend/src/main/kotlin/com/flowlink/execution/ExecutionService.kt:130-140`
- Create: `backend/src/test/kotlin/com/flowlink/execution/SingleNodeOverrideTest.kt`
- Modify: `frontend/src/api/client.ts:252` (`runNode` body 타입에 `node?: GraphNode`), `frontend/src/panels/PropertyPanel.tsx` runSingle 본문(≈170-183)

**Interfaces:**
- Produces: `RunRequest.node: GraphNode?` — 단일 실행 시 저장본 대신 이 노드를 실행(id 가 경로의 nodeId 와 같을 때만). `ExecutionService.Companion.pickSingleNode(saved: GraphNode?, override: GraphNode?, nodeId: String): GraphNode?`(순수).

- [ ] **Step 1: 실패하는 테스트**

`backend/src/test/kotlin/com/flowlink/execution/SingleNodeOverrideTest.kt`:
```kotlin
package com.flowlink.execution

import com.flowlink.core.graph.GraphNode
import com.flowlink.core.graph.NodeType
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

/** 단일 실행 노드 선택 — 편집 중 노드(override)가 같은 id 면 그것을, 아니면 저장본을 쓴다. */
class SingleNodeOverrideTest {
    private fun node(id: String, name: String) = GraphNode(id = id, name = name, type = NodeType.SET)

    @Test
    fun `override 가 같은 id 면 override`() {
        assertThat(ExecutionService.pickSingleNode(node("n1", "saved"), node("n1", "edited"), "n1")!!.name).isEqualTo("edited")
    }

    @Test
    fun `override id 가 다르면 저장본`() {
        assertThat(ExecutionService.pickSingleNode(node("n1", "saved"), node("n2", "edited"), "n1")!!.name).isEqualTo("saved")
    }

    @Test
    fun `저장본이 없어도 override 로 실행 가능(미저장 새 노드)`() {
        assertThat(ExecutionService.pickSingleNode(null, node("n1", "edited"), "n1")!!.name).isEqualTo("edited")
        assertThat(ExecutionService.pickSingleNode(null, null, "n1")).isNull()
    }
}
```
(`GraphNode` 생성자 파라미터는 `core/graph/GraphNode.kt` 를 열어 확인 — data class 에 기본값이 없으면 필요한 필드를 null 로 채운 헬퍼를 테스트 안에 둔다.)

- [ ] **Step 2: 실행해 실패 확인**

Run (in `backend/`): `./gradlew :test --tests com.flowlink.execution.SingleNodeOverrideTest` → 컴파일 실패(`pickSingleNode` 없음).

- [ ] **Step 3: 구현**

`RunRequest.kt` 에 필드 추가(마지막):
```kotlin
    /** 단일 노드 실행 전용 — 편집 중(미저장) 노드 본문. id 가 경로의 nodeId 와 같을 때만 저장본 대신 실행한다(tcp-preview 와 같은 override 규약). */
    val node: com.flowlink.core.graph.GraphNode? = null,
```
`ExecutionService.runSingleNode` 의
```kotlin
        val graph = json.parseGraph(version.graphJson)
        val node = graph.nodesOrEmpty().find { it.id == nodeId }
            ?: throw NotFoundException.of("Node", nodeId)
```
를
```kotlin
        val graph = json.parseGraph(version.graphJson)
        val node = pickSingleNode(graph.nodesOrEmpty().find { it.id == nodeId }, req?.node, nodeId)
            ?: throw NotFoundException.of("Node", nodeId)
```
로 바꾸고 companion 에 추가(기존 companion 이 있으면 그 안에):
```kotlin
        /** 단일 실행 노드 선택 — 편집 중 노드(override)의 id 가 경로와 같으면 그것(미저장 편집 반영), 아니면 저장본. */
        @JvmStatic
        fun pickSingleNode(saved: com.flowlink.core.graph.GraphNode?, override: com.flowlink.core.graph.GraphNode?, nodeId: String): com.flowlink.core.graph.GraphNode? =
            if (override != null && override.id == nodeId) override else saved
```

- [ ] **Step 4: 테스트 통과** — `./gradlew :test --tests com.flowlink.execution.SingleNodeOverrideTest` PASS.

- [ ] **Step 5: 프론트**

`client.ts` `runNode` body 타입에 `node?: GraphNode` 추가. `PropertyPanel.tsx` `runSingle` 의 body 객체에 `node: asGraphNode(n.data)` 를 넣는다(`runTcpPreview` 와 같은 `nodes.find(...)` 로 현재 노드 획득 — 이미 `body` 를 조립하는 코드 바로 위에서 `const n = nodes.find((x) => x.id === selectedId)` 가 없으면 추가). 단일 실행 결과 배너 문구에 "(편집 중 값으로 실행)" 를 붙일 필요는 없다 — 이제 항상 편집 중 값이다. `npx tsc -b`.

- [ ] **Step 6: Commit**

```bash
git add backend/src/main/kotlin/com/flowlink/execution/dto/RunRequest.kt backend/src/main/kotlin/com/flowlink/execution/ExecutionService.kt backend/src/test/kotlin/com/flowlink/execution/SingleNodeOverrideTest.kt frontend/src/api/client.ts frontend/src/panels/PropertyPanel.tsx
git commit -m "feat(exec): ▶ 이 노드만 실행이 편집 중(미저장) 노드 본문으로 실행 — RunRequest.node override(tcp-preview 규약)"
```

---

### Task 11: 응답 필드 trim/type (백엔드)

**Files:**
- Modify: `backend/src/main/kotlin/com/flowlink/core/graph/TcpRespField.kt`
- Modify: `backend/src/main/kotlin/com/flowlink/execution/engine/TcpNodeExecutor.kt:181-192`
- Create: `backend/src/test/kotlin/com/flowlink/execution/engine/TcpRespPostProcessTest.kt`

**Interfaces:**
- Produces: `TcpRespField.trim: Boolean?`, `TcpRespField.type: String?`("string"|"number"), `TcpNodeExecutor.postProcess(decoded: String, rf: TcpRespField): Any?`(companion, 순수).

- [ ] **Step 1: 실패하는 테스트**

```kotlin
package com.flowlink.execution.engine

import com.flowlink.core.graph.TcpRespField
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

class TcpRespPostProcessTest {
    private fun rf(trim: Boolean?, type: String?) = TcpRespField(id = "f", name = "x", length = 10, encoding = null, trim = trim, type = type)

    @Test fun `trim 미지정(레거시)은 원문 그대로`() { assertThat(TcpNodeExecutor.postProcess("000001500000", rf(null, null))).isEqualTo("000001500000") }
    @Test fun `문자 trim 은 후행 공백만`() { assertThat(TcpNodeExecutor.postProcess("홍길동   ", rf(true, "string"))).isEqualTo("홍길동") }
    @Test fun `숫자 trim 은 선행 0·공백 제거 후 Long`() { assertThat(TcpNodeExecutor.postProcess("000001500000", rf(true, "number"))).isEqualTo(1500000L) }
    @Test fun `숫자인데 소수점이면 Double, 숫자가 아니면 trim 된 문자열`() {
        assertThat(TcpNodeExecutor.postProcess("00012.50", rf(true, "number"))).isEqualTo(12.5)
        assertThat(TcpNodeExecutor.postProcess("  AB12 ", rf(true, "number"))).isEqualTo("AB12")
    }
    @Test fun `전부 0 이면 0`() { assertThat(TcpNodeExecutor.postProcess("0000", rf(true, "number"))).isEqualTo(0L) }
    @Test fun `type 만 number 이고 trim false 면 원문 파싱 시도`() { assertThat(TcpNodeExecutor.postProcess("0042", rf(false, "number"))).isEqualTo(42L) }
}
```

- [ ] **Step 2: 실행해 실패 확인** — 컴파일 실패(필드 없음).

- [ ] **Step 3: 구현**

`TcpRespField.kt`:
```kotlin
@JsonIgnoreProperties(ignoreUnknown = true)
data class TcpRespField(
    val id: String?,
    val name: String?,
    val length: Int?,
    val encoding: String?,
    /** 슬라이스 후 패딩 제거 — 문자=후행 공백, 숫자=선행 0·공백. null(레거시)=false. */
    val trim: Boolean? = null,
    /** "string"(기본) | "number" — number 면 숫자 원형(Long/Double)으로 출력해 조건식 숫자 비교가 된다. */
    val type: String? = null,
) {
    fun lengthOrZero(): Int = length ?: 0
}
```
`TcpNodeExecutor` 응답 슬라이싱 루프의 `value[rf.name] = decoded` → `value[rf.name] = postProcess(decoded, rf)`. companion 에 추가:
```kotlin
        /** 응답 필드 후처리(순수) — trim/type 규칙. 레거시(둘 다 null)는 원문 그대로(무회귀). */
        @JvmStatic
        fun postProcess(decoded: String, rf: TcpRespField): Any? {
            val number = rf.type == "number"
            val trimmed = when {
                rf.trim == true && number -> decoded.trim().trimStart('0').ifEmpty { "0" }
                rf.trim == true -> decoded.trimEnd()
                else -> decoded
            }
            if (!number) return trimmed
            val t = trimmed.trim().trimStart('0').ifEmpty { "0" }
            return t.toLongOrNull() ?: t.toDoubleOrNull() ?: trimmed
        }
```
(`"00012.50".trimStart('0')` → `"12.50"` → Double 12.5. `"0000"` → `""` → `"0"` → 0L.)

- [ ] **Step 4: 테스트 통과 + 전체** — `./gradlew :test --tests com.flowlink.execution.engine.TcpRespPostProcessTest` PASS → `./gradlew :test` 전종 그린.

- [ ] **Step 5: Commit**

```bash
git add backend/src/main/kotlin/com/flowlink/core/graph/TcpRespField.kt backend/src/main/kotlin/com/flowlink/execution/engine/TcpNodeExecutor.kt backend/src/test/kotlin/com/flowlink/execution/engine/TcpRespPostProcessTest.kt
git commit -m "feat(tcp): 응답 필드 trim/type — 패딩 제거·숫자 원형 출력(레거시 무회귀), 첫 성공 조건"
```

---

### Task 12: Mock 편집기 ▶ 노드 만들기 · 노드 패널 Mock 연동(고르기/만들기/정합성 칩)

**Files:**
- Create: `frontend/src/components/TcpMockLink.tsx`
- Modify: `frontend/src/routes/MockServerEditor.tsx` (도구 메뉴 ≈283-291, import)
- Modify: `frontend/src/panels/PropertyPanel.tsx` TCP `reqCol` 대상 input 아래

**Interfaces:**
- Consumes: `tcpMirror`(Task 8), `mocksApi.fleet/get/create/updateSpec/slugCheck`, `flowsApi.create/saveVersion/get`, `makeNode`, `editorStore` 클립보드 키 `'fl:node-clipboard'`(형식 `{ nodes: GraphNode[]; edges: {from,to,fromPort}[] }`).
- Produces: `TcpMockLink({ node, flowId, canEdit, onApply }: { node: GraphNode; flowId: string; canEdit: boolean; onApply: (patch: Partial<GraphNode>) => void })`.

- [ ] **Step 1: TcpMockLink**

`frontend/src/components/TcpMockLink.tsx`:
```tsx
import type { CSSProperties } from 'react'
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { flowsApi, mocksApi } from '../api/client'
import type { GraphNode, MockFleetServer } from '../api/types'
import { apiErrorMessage } from '../lib/apiError'
import { mirrorDiff, mockTcpToNode, nodeToMockTcp } from '../lib/tcpMirror'
import { toast } from './toast'

const LOCAL_HOSTS = new Set(['', 'localhost', '127.0.0.1', window.location.hostname])

/**
 * TCP 노드 ⇄ 내장 TCP Mock 연동 칩 — 같은 포트의 Mock 을 fleet(모든 워크스페이스)에서 찾아 정합성(포트·인코딩·프리픽스·필드 길이)을 보여주고,
 * [Mock 에서 고르기] 로 연결·레이아웃·응답 필드를 통째로 가져오거나 [대상 Mock 만들기] 로 이 노드의 거울 Mock 을 만든다.
 */
export function TcpMockLink({ node, flowId, canEdit, onApply }: { node: GraphNode; flowId: string; canEdit: boolean; onApply: (patch: Partial<GraphNode>) => void }) {
  const fleet = useQuery({ queryKey: ['mock-fleet'], queryFn: mocksApi.fleet, refetchInterval: 5000 })
  const flow = useQuery({ queryKey: ['flow', flowId], queryFn: () => flowsApi.get(flowId), enabled: !!flowId, staleTime: 60_000 })
  const tcpServers = useMemo(() => (fleet.data?.servers ?? []).filter((s) => s.kind === 'TCP'), [fleet.data])
  const linked = useMemo(() => (LOCAL_HOSTS.has(node.tcpHost ?? '') ? tcpServers.find((s) => s.tcpPort === node.tcpPort) : undefined), [tcpServers, node.tcpHost, node.tcpPort])
  const detail = useQuery({ queryKey: ['mock-server', linked?.id], queryFn: () => mocksApi.get(linked!.id), enabled: !!linked?.readable, staleTime: 5000 })
  const diff = useMemo(() => (detail.data?.spec.tcp ? mirrorDiff(node, detail.data.spec.tcp, detail.data.spec.tcp.rules?.[0] ?? null) : null), [detail.data, node])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const pick = async (s: MockFleetServer) => {
    setBusy(true)
    try {
      const d = await mocksApi.get(s.id)
      if (!d.spec.tcp) { toast('이 Mock 에는 TCP 정의가 없습니다', 'error'); return }
      onApply(mockTcpToNode(d.spec.tcp, d.spec.tcp.rules?.[0] ?? null, window.location.hostname || 'localhost'))
      toast(`'${d.name}' 의 연결·레이아웃·응답 필드를 가져왔습니다`, 'ok')
      setOpen(false)
    } catch (e) { toast(apiErrorMessage(e, '가져오기 실패'), 'error') } finally { setBusy(false) }
  }
  const createMock = async () => {
    setBusy(true)
    try {
      const base = `tcp-${(node.name || 'node').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'node'}`
      let slug = base
      for (let i = 2; !(await mocksApi.slugCheck(slug)).available && i < 50; i++) slug = `${base}-${i}`
      const created = await mocksApi.create({ name: `${node.name || 'TCP'} (Mock)`, slug, type: 'TCP', workspaceId: flow.data?.workspaceId ?? 'public' })
      const port = created.spec.tcp?.port ?? node.tcpPort
      await mocksApi.updateSpec(created.id, { ...created.spec, tcp: nodeToMockTcp(node, { port }) }, { note: '워크플로 TCP 노드에서 생성' })
      onApply({ tcpHost: window.location.hostname || 'localhost', tcpPort: port })
      toast(`대상 Mock '${created.name}' 을 만들고 노드 대상을 :${port} 로 맞췄습니다`, 'ok')
    } catch (e) { toast(apiErrorMessage(e, 'Mock 만들기 실패'), 'error') } finally { setBusy(false) }
  }

  return (
    <div style={wrap}>
      {linked ? (
        <span style={chip(linked.listening ? 'ok' : 'warn')} title={linked.readable ? undefined : '접근 권한이 없는 워크스페이스의 Mock'}>
          🔌 Mock '{linked.name}' :{linked.tcpPort} {linked.listening ? '· 리스닝' : linked.listenError ? '· 바인딩 실패' : '· 꺼짐'}
        </span>
      ) : <span style={chip('muted')}>🔌 같은 포트의 내장 Mock 없음</span>}
      {diff && (diff.length === 0
        ? <span style={chip('ok')}>✓ 레이아웃 일치</span>
        : <details style={{ fontSize: 11.5 }}><summary style={{ cursor: 'pointer', color: 'var(--fl-put, #f5a623)' }}>⚠ 불일치 {diff.length}</summary>
            <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>{diff.map((d) => <li key={d.field}>{d.field}: 노드 {d.node} / Mock {d.mock}</li>)}</ul>
            {canEdit && linked && <button style={btn} disabled={busy} onClick={() => pick(linked)}>Mock 값으로 맞추기</button>}
          </details>)}
      {canEdit && (
        <span style={{ position: 'relative' }}>
          <button style={btn} disabled={busy} onClick={() => setOpen((v) => !v)} aria-expanded={open}>Mock 에서 고르기 ▾</button>
          {open && (
            <div style={menu} role="menu">
              {tcpServers.length === 0 && <div style={{ padding: 8, fontSize: 12, color: 'var(--fl-text-muted)' }}>TCP Mock 이 없습니다</div>}
              {tcpServers.map((s) => (
                <button key={s.id} role="menuitem" style={item} disabled={!s.readable || busy} title={s.readable ? undefined : '읽기 권한 없음'} onClick={() => pick(s)}>
                  {s.name} <span style={{ color: 'var(--fl-text-muted)' }}>:{s.tcpPort} {s.listening ? '● 리스닝' : '○'}</span>
                </button>
              ))}
            </div>
          )}
        </span>
      )}
      {canEdit && !linked && <button style={btn} disabled={busy} onClick={createMock} title="이 노드의 요청 레이아웃/응답 필드를 거울로 가진 TCP Mock 을 만들고 대상을 그 포트로 맞춥니다">대상 Mock 만들기</button>}
    </div>
  )
}

const wrap: CSSProperties = { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', margin: '4px 0 8px' }
function chip(kind: 'ok' | 'warn' | 'muted'): CSSProperties {
  const color = kind === 'ok' ? 'var(--fl-ok)' : kind === 'warn' ? 'var(--fl-put, #f5a623)' : 'var(--fl-text-muted)'
  return { fontSize: 11.5, padding: '2px 8px', borderRadius: 999, border: `1px solid ${color}`, color }
}
const btn: CSSProperties = { fontSize: 11.5, padding: '3px 8px', border: '1px solid var(--fl-border)', borderRadius: 6, background: 'var(--fl-surface)', color: 'var(--fl-text)', cursor: 'pointer' }
const menu: CSSProperties = { position: 'absolute', top: '110%', left: 0, zIndex: 50, minWidth: 240, background: 'var(--fl-surface)', border: '1px solid var(--fl-border)', borderRadius: 8, boxShadow: 'var(--fl-shadow)', padding: 4, display: 'grid' }
const item: CSSProperties = { textAlign: 'left', padding: '6px 8px', border: 'none', background: 'transparent', color: 'var(--fl-text)', cursor: 'pointer', fontSize: 12.5, borderRadius: 6 }
```
(`MockFleetServer` 필드명(`kind`, `tcpPort`, `listening`, `listenError`, `readable`, `name`, `id`)은 `types.ts:630-647` 을 열어 맞춘다. `MockServerDetail.spec.tcp` 경로도 확인.)

- [ ] **Step 2: PropertyPanel 에 꽂기**

TCP `reqCol` 의 대상 input(`aria-label="대상 host:port"`) 바로 아래에:
```tsx
            {flowId && <TcpMockLink node={node} flowId={flowId} canEdit={canEdit} onApply={(patch) => update(id, patch)} />}
```
import: `import { TcpMockLink } from '../components/TcpMockLink'`.

- [ ] **Step 3: MockServerEditor 도구 메뉴 — ▶ 노드 만들기**

import: `import { makeNode } from '../canvas/nodeFactory'`, `import { mockTcpToNode } from '../lib/tcpMirror'`, `import { flowsApi } from '../api/client'`(이미 있으면 생략). 컴포넌트 안에 함수 2개:
```tsx
  const buildTcpNode = () => {
    const rule = tcpRules[0] ?? null
    const n = makeNode('tcp', 300, 120)
    return { ...n, ...mockTcpToNode(tcp, rule, window.location.hostname || 'localhost'), name: `${d?.name ?? 'TCP'} 호출` }
  }
  const copyTcpNode = () => {
    try { localStorage.setItem('fl:node-clipboard', JSON.stringify({ nodes: [buildTcpNode()], edges: [] })); toast('TCP 노드를 복사했습니다 — 워크플로 에디터 캔버스에서 Ctrl+V', 'ok') }
    catch { toast('복사 실패(localStorage)', 'error') }
  }
  const newFlowWithTcpNode = async () => {
    try {
      const start = makeNode('start', 60, 120)
      const tcpNode = buildTcpNode()
      const f = await flowsApi.create({ name: `${d?.name ?? 'TCP'} 호출`, workspaceId: d?.workspaceId ?? 'public' })
      await flowsApi.saveVersion(f.id, { graph: { nodes: [start, tcpNode], edges: [{ id: 'e1', from: start.id, to: tcpNode.id, fromPort: 'out' }] }, note: 'TCP Mock 에서 생성' })
      toast(`워크플로 '${f.name}' 을 만들었습니다`, 'ok')
      navigate(`/flows/${f.id}`)
    } catch (e) { toast(apiErrorMessage(e, '워크플로 만들기 실패'), 'error') }
  }
```
도구 메뉴(`toolsMenu` 안, `⧉ 이 Mock 복제` 다음)에 TCP 일 때만:
```tsx
                    {isTcp && canEditGlobal && <button style={toolItem} onClick={() => { void newFlowWithTcpNode(); setToolsOpen(false) }}>▶ 이 Mock 을 부르는 TCP 노드 만들기 (새 워크플로)</button>}
                    {isTcp && <button style={toolItem} onClick={() => { copyTcpNode(); setToolsOpen(false) }}>⧉ TCP 노드 복사 (에디터에서 Ctrl+V)</button>}
```
(`d.workspaceId` 필드명·`GraphEdge.id` 필수 여부는 `types.ts:168-173` 대로 — `id` 필수. `canEditGlobal` 변수명은 파일 상단(≈61행) 확인.)

- [ ] **Step 4: tsc·lint·build·수동 확인**

브라우저: TCP Mock 편집기 ⋯ 도구 → ▶ 새 워크플로 → 에디터에 시작+TCP 노드, 노드 패널에 🔌 Mock 칩 + ✓ 레이아웃 일치 → ▶ 이 노드만 실행 → 응답 4필드(잔액 1500000 숫자). 노드 포트를 바꾸면 ⚠ 불일치 → "Mock 값으로 맞추기".

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/TcpMockLink.tsx frontend/src/panels/PropertyPanel.tsx frontend/src/routes/MockServerEditor.tsx
git commit -m "feat(tcp): 노드⇄Mock 거울 생성 — Mock 편집기 ▶ 노드 만들기(새 워크플로/클립보드), 노드 패널 Mock 에서 고르기·대상 Mock 만들기·정합성 칩(fleet)"
```

---

### Task 13: 브라우저 e2e · 가이드 · CLAUDE.md

**Files:**
- Create(세션 스크래치): `pw/tcp-authoring.mjs` (Playwright, 격리 인스턴스 — `SPRING_PROFILES_ACTIVE=h2 FLOWLINK_H2_FILE=<임시> FLOWLINK_PORT=18081 java -jar backend/build/libs/flowlink.jar` — 기존 스위트 관례)
- Modify: `docs/guide/03-노드-레퍼런스.md`(TCP 절 — 파일명은 `ls docs/guide` 로 확인), `docs/guide/10-Mock-서버.md`(TCP 편집기 절), `CLAUDE.md`(최근 변경 섹션 — 설계 항목을 "1차 구현됨" 으로 갱신)

- [ ] **Step 1: e2e 시나리오(단언 ≥ 20)**

1. TCP Mock 생성(API) → 편집기 → 요청 레이아웃 [텍스트] 에 `전문코드 4\n계좌번호 10\n지점코드 3` 입력 → [필드] → 행 3 → 📋 붙여넣기(TSV 헤더 3행) → 적용(교체) → 행 3 · 총 바이트 → 저장.
2. 규칙 응답 [텍스트] → `응답코드 4 문자 = 0000\n잔액 12 숫자 = 99` 로 교체 → [필드] → 패딩 ←/0 확인 → 템플릿(고급) 클릭 → 확인 문구 → 취소(필드 유지).
3. ⋯ 도구 → ▶ 새 워크플로 → 에디터 → TCP 노드 선택 → 🔌 칩 + ✓ 일치 → ▶ 이 노드만 실행(미저장 상태에서 요청 값 수정 후 실행 → 응답에 수정값 반영 = override) → 출력 `잔액` 이 숫자(`99`).
4. 노드 요청 필드 📋 붙여넣기 → 샘플 전문 `001402001234567890` → "자기 미포함" 문구 + 샘플 대조 ✓ → 적용.
5. HTTP 노드 본문 필드 number+토큰 → Raw 따옴표 없음 → 필드 복귀 number 유지; 헤더 Raw 에 콜론 없는 줄 → 경고 문구 + 나머지 변환.
6. 콘솔/페이지 에러 0.

- [ ] **Step 2: 가이드**

`03`(TCP 노드): "정의서 붙여넣기 / 텍스트 한 줄 문법 / Mock 에서 고르기 / 응답 trim·숫자" 절(문법 표 = 스펙 §3 P1 문법). `10`(TCP Mock): "레이아웃·응답 필드 [필드|텍스트], 📋 붙여넣기, ▶ 이 Mock 을 부르는 노드 만들기" 절. 라벨은 실제 UI 문자열과 일치시킨다.

- [ ] **Step 3: CLAUDE.md**

"최근 변경 (2026-09-11) — 설계만" 섹션 제목을 "(2026-09-13) — 1차 구현" 으로 바꾸고 구현 내용(파일·테스트 수·e2e 단언 수)을 6~10줄로. `⚠` 에 "DSL 직렬화는 공백 구분 1종, trim 은 새 노드만 기본 true, 2차(바이트 자·안내)·3차(나머지 인벤토리·AI)는 스펙 §5 참조".

- [ ] **Step 4: 전체 검증**

- backend: `./gradlew :test` 전종 그린
- frontend: `npm test` · `npx tsc -b` · `npm run lint` · `npm run build`
- e2e: `node pw/tcp-authoring.mjs` 전 단언 PASS(격리 18081 인스턴스, 끝나면 종료)

- [ ] **Step 5: Commit**

```bash
git add docs/guide CLAUDE.md
git commit -m "docs(tcp): 정의서 붙여넣기·텍스트 문법·거울 생성·응답 trim 가이드(03·10장) + CLAUDE.md 1차 구현 기록"
```

---

## Self-Review

- **Spec coverage(1차 §5 1~7)**: ① vitest+textForms(Task 1-3) ② FieldTextToggle+TCP 4곳+HTTP 4토글+Mock 3모드(Task 4·6·7) ③ TcpLayoutPaste 4곳(Task 5·6·7) ④ tcpMirror+기본값+▶노드 만들기+고르기/만들기/칩(Task 8·9·12) ⑤ 단일 실행 override(Task 10) ⑥ trim/type(Task 2 타입·6 UI·11 백엔드) ⑦ 가이드+e2e(Task 13). 스펙 §4 1차 행(tcp 값/값없음·HTTP 본문·kv-url·headers)은 Task 2·3·6 이 커버. 2차 항목(바이트 자·5단계 바·kv/.env 폼·JSON 모달)은 의도적으로 제외.
- **Type consistency**: `LayoutRow`(Task 2) ↔ `TcpField/TcpRespField/MockTcpReqField/MockTcpRespField` 캐스팅(Task 6·7) ↔ `TcpRespField.trim/type`(Task 2 프론트, Task 11 백엔드) ↔ `mockTcpToNode` 가 `trim: true`·`type` 채움(Task 8) ↔ nodeFactory 기본값(Task 9). `KvRow.id` 필수 — PropertyPanel 이 `f.id` 를 넣는다(Task 6). `RunRequest.node`(Task 10) ↔ `runsApi.runNode` body(Task 10).
- **Placeholder scan**: 코드 블록 안 "…기존 그대로…" 는 원문 유지 지시(변경 없음)로만 사용. 파일명/필드명 확인 지시("열어 확인")는 실제 코드 대조 요구이며 구현 누락이 아님.
