// 서버 메시지를 우선하고, 연결 실패·시간 초과는 사용자가 대응할 수 있는 한국어로 표시한다.
export function apiErrorMessage(e: unknown, fallback = '요청에 실패했습니다'): string {
  const anyE = e as { response?: { data?: { message?: string } }; message?: string; code?: string }
  const serverMessage = anyE?.response?.data?.message
  if (typeof serverMessage === 'string' && serverMessage.trim()) return serverMessage
  if (anyE?.code === 'ECONNABORTED' || anyE?.code === 'ETIMEDOUT') return '요청 시간이 초과되었습니다. 연결 상태를 확인한 뒤 다시 시도하세요.'
  if (anyE?.code === 'ERR_NETWORK' || anyE?.message === 'Network Error') return '서버에 연결하지 못했습니다. 연결 상태를 확인한 뒤 다시 시도하세요.'
  const httpStatus = anyE?.message?.match(/^Request failed with status code (\d{3})$/)?.[1]
  if (httpStatus) {
    const messages: Record<string, string> = {
      '400': '요청 내용을 확인한 뒤 다시 시도하세요.',
      '401': '로그인이 필요합니다. 다시 로그인한 뒤 시도하세요.',
      '403': '이 작업을 수행할 권한이 없습니다.',
      '404': '요청한 항목을 찾을 수 없습니다. 목록을 새로고침하세요.',
      '409': '다른 곳에서 변경되었습니다. 최신 내용을 확인한 뒤 다시 시도하세요.',
      '429': '요청이 너무 많습니다. 잠시 후 다시 시도하세요.',
      '503': '서버가 잠시 응답할 수 없습니다. 잠시 후 다시 시도하세요.',
    }
    return messages[httpStatus] ?? `${fallback} (HTTP ${httpStatus})`
  }
  return anyE?.message ?? fallback
}
