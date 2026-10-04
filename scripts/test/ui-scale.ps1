# Disposable local lab fixtures for workspace/resource UI checks. No MCP calls.
param([Parameter(Mandatory=$true)][string]$AgentFile)
$ErrorActionPreference='Stop'
$Agent=Get-Content -LiteralPath $AgentFile -Raw|ConvertFrom-Json
if(([uri]$Agent.baseUrl).Host -ne '127.0.0.1' -or -not $AgentFile.Contains('agent-lab')) {throw 'Use the isolated local lab agent.'}
$Tag='ui-scale-'+[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
function Api($Path,$Method='GET',$Body=$null) {
  $Args=@{Uri=$Agent.baseUrl+'/api/v1/remote'+$Path;Method=$Method;Headers=@{'X-FlowLink-Local'=$Agent.token};UseBasicParsing=$true}
  if($null -ne $Body){$Args.ContentType='application/json';$Args.Body=[Text.Encoding]::UTF8.GetBytes(($Body|ConvertTo-Json -Depth 30 -Compress))}
  $R=Invoke-WebRequest @Args
  if($R.Content){$R.Content|ConvertFrom-Json}
}
$Teams=@();$Domains=@('결제 플랫폼','회원 인증','주문 처리','정산 운영','배송 연동','리스크 관리')
for($I=1;$I -le 48;$I++) {
  $Teams+=Api '/workspaces' 'POST' @{name=('UI 검증 · '+$Domains[($I-1)%6]+' · '+$I.ToString('000')+' · '+$Tag)}
}
$Space=$Teams[0].id
Write-Output '48 named workspaces created'
for($I=1;$I -le 240;$I++) {
  $Slug=$Tag+'-'+$I.ToString('000')
  $M=Api '/mock-servers' 'POST' @{name=($Domains[($I-1)%6]+' / 외부기관 통합 연동 검증 환경 / '+$I.ToString('000'));slug=$Slug;workspaceId=$Space;type='HTTP'}
  $null=Api "/mock-servers/$($M.id)/spec" 'PUT' @{spec=@{routes=@(@{id='health';method='GET';path='/status';rules=@(@{id='ok';status=200;contentType='json';body='{"testFixture":true}'})})}}
  if($I%3 -eq 0){$null=Api "/mock-servers/$($M.id)" 'PATCH' @{enabled=$false}}
}
Write-Output '240 Mock definitions created (160 running, 80 stopped)'
for($I=1;$I -le 60;$I++) {
  $Vars=@{ BASE_URL='https://example.invalid'; REGION='TEST'; FIXTURE=$Tag }
  if($I -eq 1) {for($J=1;$J -le 360;$J++){$Vars['PAYMENT_FIELD_'+$J.ToString('000')]='검증용 값 '+$J}}
  $null=Api "/environments/environment-$($I.ToString('000'))?workspaceId=$Space" 'PUT' @{vars=$Vars}
}
Write-Output '60 environments created, first with 363 variables'
for($I=1;$I -le 180;$I++) {
  $Env=if($I%3 -eq 0){$null}else{'environment-'+(($I%60)+1).ToString('000')}
  $null=Api "/secrets/PAYMENT_INTEGRATION_TEST_KEY_$($I.ToString('000'))?workspaceId=$Space" 'PUT' @{value='not-a-real-credential-'+$Tag+'-'+$I;environment=$Env}
}
Write-Output '180 dummy secret entries created (no real credentials)'
$Fields=@();for($I=1;$I -le 450;$I++){$Fields+=@{id="field$I";key=('payment.customer.item_'+$I.ToString('000'));value=('검증 필드 '+$I);type='string'}}
$F=Api '/flows' 'POST' @{name='대량 필드 편집 검증 · 450개';workspaceId=$Space}
$null=Api "/flows/$($F.id)/versions" 'POST' @{graph=@{nodes=@(@{id='s';type='start';x=40;y=100},@{id='request';type='http';name='결제 요청 · 450개 필드';method='POST';executionAgent='server';baseUrl='https://example.invalid';bodyType='json';respType='json';x=300;y=100;fields=@{body=$Fields;params=@();headers=@()}},@{id='e';type='end';x=560;y=100});edges=@(@{id='a';from='s';to='request'},@{id='b';from='request';to='e'})}}
$File=Join-Path (Split-Path -Parent $AgentFile) 'ui-scale-fixtures.json'
@{tag=$Tag;workspace=$Space;workspaces=$Teams.id;flow=$F.id;mockCount=240;environmentCount=60;secretCount=180;fieldCount=450}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $File -Encoding UTF8
Write-Output "Scale fixtures saved: $File"
