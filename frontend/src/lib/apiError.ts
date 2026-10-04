// 서버 메시지를 우선하고, 연결 실패·시간 초과는 사용자가 대응할 수 있는 한국어로 표시한다.
export function apiErrorMessage(e: unknown, fallback = '요청에 실패했습니다'): string {
  const anyE = e as { response?: { data?: { message?: string } }; message?: string; code?: string }
  const serverMessage = anyE?.response?.data?.message
  if (serverMessage != null) return serverMessage
  if (anyE?.code === 'ECONNABORTED' || anyE?.code === 'ETIMEDOUT') return '요청 시간이 초과되었습니다. 연결 상태를 확인한 뒤 다시 시도하세요.'
  if (anyE?.code === 'ERR_NETWORK' || anyE?.message === 'Network Error') return '서버에 연결하지 못했습니다. 연결 상태를 확인한 뒤 다시 시도하세요.'
  return anyE?.message ?? fallback
}
