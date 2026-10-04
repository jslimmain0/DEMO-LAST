// 시크릿 볼트·환경 변수 칩 소스 — Mock/워크플로 문맥이 없는 입력(플러그인 실행 패널, 프로토콜 코덱 파라미터)에서도
// {{ 이름@secret }}·{{ 키@env }} 를 넣을 수 있게. 값은 서버가 실행/시험 시점의 환경 스코프로 푼다.
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useApi } from '../app/WorkspaceContext'
import type { EnvView, SecretView } from '../api/client'
import type { BindableSource } from '../binding/upstream'
import { applicableSecretNames, envKeys, srcItem } from './mockSources'

export function vaultSources(secrets: SecretView[] | undefined, envs: EnvView[] | undefined, environment: string | null | undefined): BindableSource[] {
  const out: BindableSource[] = []
  const sec = applicableSecretNames(secrets, environment)
  if (sec.length) out.push({ id: 'secret', name: '시크릿 볼트', type: 'mock', cat: 'secret', items: sec.map((k) => srcItem(k, '시크릿')) })
  const ek = envKeys(envs, environment, true)
  if (ek.length) out.push({ id: 'env', name: environment ? `환경 변수 (${environment})` : '환경 변수', type: 'mock', cat: 'env', items: ek.map((k) => srcItem(k, '환경')) })
  return out
}

/** environment = 값을 풀 환경 — 플러그인 시험은 활성 환경, 프로토콜 편집은 null(모든 환경의 키 합집합 — 실행 환경에 따라 풀림). */
export function useVaultSources(environment: string | null | undefined): BindableSource[] {
  const { environmentsApi, secretsApi } = useApi()
  const secrets = useQuery({ queryKey: ['secrets'], queryFn: secretsApi.list, staleTime: 30_000, retry: false })
  const envs = useQuery({ queryKey: ['environments'], queryFn: environmentsApi.list, staleTime: 30_000, retry: false })
  return useMemo(() => vaultSources(secrets.data, envs.data, environment), [secrets.data, envs.data, environment])
}
