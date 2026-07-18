package com.flowlink.security

/**
 * 앱 GitHub 로그인 성공 시 발행되는 이벤트. 어시스턴트(Copilot 연결)가 받아 **같은 GitHub 토큰을 재사용**한다
 * — 앱 로그인과 Copilot 연결이 같은 계정·client_id·scope(read:user)라 한 번의 로그인으로 둘 다 연결된다.
 *
 * 보안 모듈이 어시스턴트 모듈에 직접 의존하지 않도록 이벤트로 느슨하게 연결한다(방향: assistant → security).
 *
 * @property login GitHub 로그인명(= 앱 JWT subject).
 * @property githubToken 디바이스 플로우로 받은 GitHub access token(암호화 저장은 수신 측이 담당).
 * @property tenant 앱 JWT 가 부여한 테넌트(현재 GitHub 로그인은 항상 "default").
 * @property clientId 토큰을 발급한 OAuth client_id — 수신 측이 Copilot client 일 때만 Copilot 연결로 채택.
 */
data class GithubLoginEvent(
    val login: String,
    val githubToken: String,
    val tenant: String,
    val clientId: String,
)
