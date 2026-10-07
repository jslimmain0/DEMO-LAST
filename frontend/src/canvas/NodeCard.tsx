import { NodeAgentBadge, useNodeResources } from '../components/AgentSettings'
import { useQuery } from '@tanstack/react-query'
import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'

import type { HttpMethod } from '../api/types'
import { MethodTag } from '../components/MethodTag'
import { AppIcon, NodeTypeIcon } from '../components/AppIcon'
import { getReachInfoCached } from '../lib/reachable'
import { useEditorStore } from '../store/editorStore'
import { asGraphNode } from './graphAdapter'
import { NODE_W, TERMINAL_W, METHOD_COLOR, typeLabel } from './nodeMeta'
import './node-visuals.css'

export function NodeCard({ data, selected }: NodeProps) {
  const n = asGraphNode(data)
  const resources = useNodeResources(n)
  const { protocolsApi } = resources.api
  const collapsed = !!n.collapsed
  const toggleCollapse = useEditorStore((s) => s.toggleNodeCollapse)
  const waitingId = useEditorStore((s) => s.waitingNodeId)
  const runState = useEditorStore((s) => s.runView?.nodeStates[n.id])
  // 시작에서 도달 못 하는 실행 노드 = 실행 시 건너뜀. 실행 전에 점선 테두리로 미리 표시.
  const unreachable = useEditorStore((s) => {
    if (n.type === 'start' || n.type === 'note' || n.type === 'group') return false
    const info = getReachInfoCached(s.nodes, s.edges)
    return info.hasStart && !info.reachable.has(n.id)
  })
  const waiting = waitingId === n.id || runState === 'waiting'
  const waitingLabel = n.type === 'wait' ? '콜백 대기 중' : n.type === 'input' ? '사용자 입력 대기' : n.type === 'form' ? '폼 전송 대기' : n.type === 'http' && n.reqMode === 'client' && !n.executionAgent ? '브라우저 요청 대기' : '에이전트 작업 대기'
  const running = runState === 'running'
  const isStart = n.type === 'start'
  const isEnd = n.type === 'end'
  const isHttp = n.type === 'http'
  const isTcp = n.type === 'tcp'
  const configuredAddress = n.agentMock ? `Mock · ${n.agentMock}` : n.baseUrlBound ? '상위 노드에서 받은 주소' : `${n.baseUrl ?? ''}${n.path || '/'}`
  const requestAddress = configuredAddress.split(/[?#]/)[0].replace(/(https?:\/\/)[^{}/]*@/, '$1')
  // 프로토콜 이름을 보여주려면 목록이 필요 — TCP 노드일 때만 조회(Editor 가 QueryClientProvider 로 감싸고 있다)
  const protos = useQuery({ queryKey: [...resources.key, 'protocols'], queryFn: protocolsApi.list, staleTime: 30_000, enabled: isTcp && resources.available })
  const pname = protos.data?.find((p) => p.id === n.protocolId)?.name

  const showUnreachable = unreachable && !selected && !runState && !waiting && !running
  const borderColor = waiting
    ? 'var(--fl-waiting)'
    : running
      ? 'var(--fl-running)'
      : runState === 'failed'
        ? 'var(--fl-fail)'
        : selected
          ? 'var(--fl-primary)'
          : runState === 'success'
            ? 'var(--fl-ok)'
            : showUnreachable
              ? 'var(--fl-put)'
              : 'var(--fl-border)'

  const collapseButton = <button
    className="nodrag"
    onClick={(e) => { e.stopPropagation(); toggleCollapse(n.id) }}
    title={collapsed ? '펴기' : '접기'}
    aria-label={collapsed ? '노드 펴기' : '노드 접기'}
    style={{ flexShrink: 0, width: 18, height: 18, padding: 0, border: 'none', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer' }}
  ><AppIcon name={collapsed ? 'chevronRight' : 'chevronDown'} size={12} /></button>

  if (isStart || isEnd) return <div className="fl-editor-terminal" style={{ width: TERMINAL_W, opacity: runState === 'skipped' ? .55 : 1 }}>
    <div className={`fl-terminal-orb${selected ? ' fl-editor-node--selected' : ''}${running ? ' fl-node-running' : ''}`}
      title={showUnreachable ? '미연결 — 실행 시 건너뜁니다' : n.name ?? typeLabel(n.type)}
      style={{ color: isStart ? 'var(--fl-ok)' : 'var(--fl-text-soft)', borderStyle: showUnreachable ? 'dashed' : 'solid', borderColor: selected || runState || waiting || showUnreachable ? borderColor : isStart ? 'var(--fl-ok)' : 'var(--fl-control-border)' }}>
      {!isStart && <Handle type="target" position={Position.Left} className="fl-handle" />}
      <AppIcon name={isStart ? 'play' : 'stop'} size={24} />
      <span className="fl-terminal-status"><RunBadge state={waiting ? 'waiting' : runState} waitingLabel={waitingLabel} /></span>
      {!isEnd && <Handle type="source" id="out" position={Position.Right} className="fl-handle" />}
    </div>
    <div className="fl-terminal-label"><span title={n.name ?? typeLabel(n.type)}>{n.name ?? typeLabel(n.type)}</span>{collapseButton}</div>
    {!collapsed && showUnreachable && <div style={{ color: 'var(--fl-put)', fontSize: 10, textAlign: 'center' }}>⚠ 미연결</div>}
  </div>

  const subtitle = waiting ? `${waitingLabel}…` : running ? '실행 중…' : runState === 'skipped' ? '건너뜀' : showUnreachable ? '⚠ 미연결'
    : isHttp ? requestAddress : isTcp ? `${pname ?? '(프로토콜 없음)'} · ${n.tcpMessage || '(미선택)'}` : typeLabel(n.type)

  return (
    <div
      className={`fl-editor-node${selected ? ' fl-editor-node--selected' : ''}${running ? ' fl-node-running' : ''}`}
      style={{
        width: NODE_W, // 고정 폭 — URL/이름이 길어도 늘어나지 않는다(말줄임). fitBounds NODE_W 와 일치
        background: 'var(--fl-surface)',
        border: `1px ${showUnreachable ? 'dashed' : 'solid'} ${borderColor}`,
        borderRadius: 'var(--fl-radius)',
        boxShadow: selected ? 'var(--fl-shadow-lg)' : 'var(--fl-shadow)',
        fontFamily: 'var(--fl-font-ui)',
        opacity: runState === 'skipped' ? 0.55 : 1,
      }}
    >
      <Handle type="target" position={Position.Left} className="fl-handle" />

      <div className="fl-task-header">
        <NodeTypeIcon type={n.type} size={36} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="fl-task-title" title={n.name ?? typeLabel(n.type)}>
            {n.name ?? typeLabel(n.type)}
          </div>
          {!collapsed && (
            <div className="fl-task-subtitle" title={subtitle} style={{ color: showUnreachable ? 'var(--fl-put)' : undefined, fontWeight: showUnreachable ? 600 : 400 }}>
              {subtitle}
            </div>
          )}
        </div>
        <RunBadge state={waiting ? 'waiting' : runState} waitingLabel={waitingLabel} />
        {collapseButton}
      </div>
      {!collapsed && <div className="fl-task-footer">
        <NodeAgentBadge node={n} />
        {isHttp && <>
          <span className="fl-editor-method" style={{ color: METHOD_COLOR[(n.method ?? 'GET') as HttpMethod] }}><MethodTag method={(n.method ?? 'GET') as HttpMethod} /></span>
          {n.method && n.method !== 'GET' && n.method !== 'HEAD' && (
            <span title={`본문 종류: ${n.bodyType ?? 'json'}`} style={{ flexShrink: 0, fontSize: 9.5, fontWeight: 700, fontFamily: 'var(--fl-font-mono)', padding: '2px 5px', borderRadius: 'var(--fl-radius-pill)', color: 'var(--fl-text-muted)', background: 'var(--fl-surface)', border: '1px solid var(--fl-border)' }}>
              {(n.bodyType === 'form' || n.bodyType === 'urlencoded') ? 'FORM' : (n.bodyType ?? 'json').toUpperCase()}
            </span>
          )}
          {n.reqMode === 'client' && !n.executionAgent && <span style={{ fontSize: 10, color: 'var(--fl-waiting)' }}>브라우저 호환</span>}
        </>}
        {isTcp && <>
          <span style={{ color: 'var(--fl-text-soft)', fontWeight: 600 }}>TCP</span>
          <span title={`${n.tcpHost ?? ''}:${n.tcpPort ?? ''}`} style={{ flexShrink: 0, maxWidth: 92, fontSize: 10, fontFamily: 'var(--fl-font-mono)', color: 'var(--fl-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {(n.tcpHost || '(host)') + (n.tcpPort ? ':' + n.tcpPort : '')}
          </span>
        </>}
      </div>}

      <Handle type="source" id="out" position={Position.Right} className="fl-handle" />
    </div>
  )
}

/** 실행 경과 배지 — 진행 중 스피너 / 성공 ✓ / 실패 ✕ / 건너뜀 ⊘ / 대기 펄스. (role=img 로 보조기기 노출) */
export function RunBadge({ state, waitingLabel = '대기 중' }: { state?: string; waitingLabel?: string }) {
  if (state === 'waiting') return <span role="img" className="fl-wait-dot" title={waitingLabel} aria-label={waitingLabel} />
  if (state === 'running') return <span role="img" className="fl-run-spinner" title="실행 중" aria-label="실행 중" />
  if (state === 'success') return <span role="img" className="fl-run-badge" style={{ color: 'var(--fl-ok)' }} title="성공" aria-label="성공">✓</span>
  if (state === 'failed') return <span role="img" className="fl-run-badge" style={{ color: 'var(--fl-fail)' }} title="실패" aria-label="실패">✕</span>
  if (state === 'skipped') return <span role="img" className="fl-run-badge" style={{ color: 'var(--fl-text-muted)' }} title="건너뜀" aria-label="건너뜀">⊘</span>
  return null
}
