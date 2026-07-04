// axios 에러에서 사용자에게 보여줄 메시지를 뽑아낸다(서버 ApiError.message → 예외 message → 폴백).
export function apiErrorMessage(e: unknown, fallback = '요청에 실패했습니다'): string {
  const anyE = e as { response?: { data?: { message?: string } }; message?: string }
  return anyE?.response?.data?.message ?? anyE?.message ?? fallback
}
