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
