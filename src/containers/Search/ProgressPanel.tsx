'use client';

import { Chip, LinearProgress, Paper, Stack, Typography } from '@mui/material';
import type { AdapterEventStatus, AgentEventStatus, SearchCriteria, SearchEvent, SearchPhase } from '~/types';

const PHASES: { key: SearchPhase; label: string }[] = [
  { key: 'intake', label: 'Intake' },
  { key: 'acquisition', label: 'Adquisición' },
  { key: 'numeric_gate', label: 'Gate numérico' },
  { key: 'textual_eval', label: 'Evaluación' },
  { key: 'ranking', label: 'Ranking' },
];

const AGENT_COLOR: Record<AgentEventStatus, 'default' | 'info' | 'success' | 'error' | 'warning'> = {
  running: 'info',
  ok: 'success',
  error: 'error',
  skipped: 'warning',
};

const ADAPTER_COLOR: Record<AdapterEventStatus, 'default' | 'info' | 'success' | 'error' | 'warning'> = {
  running: 'info',
  ok: 'success',
  blocked: 'warning',
  error: 'error',
};

type PhaseEvent = { type: 'phase'; phase: SearchPhase };
type CriteriaEvent = { type: 'criteria'; criteria: SearchCriteria };
type AdapterEvent = { type: 'adapter'; portal: string; status: AdapterEventStatus; count?: number; detail?: string };
type EvalEvent = { type: 'eval'; listingId: string; replica: number; status: AgentEventStatus; detail?: string };
type DetailEvent = { type: 'detail'; fetched: number; total: number };
type GateEvent = { type: 'gate'; survived: number; total: number };
type TokensEvent = { type: 'tokens'; total: number; budget: number };
type DoneEvent = { type: 'done'; resultCount: number; degraded: boolean; partial: boolean };
type ErrorEvent = { type: 'error'; message: string };

type Props = { events: SearchEvent[] };

export const ProgressPanel = ({ events }: Props) => {
  const phaseKeys = PHASES.map((p) => p.key);
  const currentPhase = [...events]
    .reverse()
    .find((e): e is PhaseEvent => e.type === 'phase' && phaseKeys.includes(e.phase));
  const phaseIdx = PHASES.findIndex((p) => p.key === currentPhase?.phase);
  const doneEvent = events.find((e): e is DoneEvent => e.type === 'done');
  const hasError = events.some((e) => e.type === 'error');
  const criteriaEvent = events.find((e): e is CriteriaEvent => e.type === 'criteria');

  const adapters = new Map<string, { status: AdapterEventStatus; count?: number; detail?: string }>();
  const evals = new Map<string, { status: AgentEventStatus; detail?: string }>();
  let tokens: { total: number; budget: number } | undefined;
  let gateResult: { survived: number; total: number } | undefined;
  let detailProgress: { fetched: number; total: number } | undefined;

  for (const e of events) {
    if (e.type === 'adapter') {
      const ae = e as AdapterEvent;
      adapters.set(ae.portal, { status: ae.status, count: ae.count, detail: ae.detail });
    }
    if (e.type === 'eval') {
      const ee = e as EvalEvent;
      evals.set(`${ee.listingId}#${ee.replica}`, { status: ee.status, detail: ee.detail });
    }
    if (e.type === 'tokens') {
      const te = e as TokensEvent;
      tokens = { total: te.total, budget: te.budget };
    }
    if (e.type === 'gate') {
      const ge = e as GateEvent;
      gateResult = { survived: ge.survived, total: ge.total };
    }
    if (e.type === 'detail') {
      const de = e as DetailEvent;
      detailProgress = { fetched: de.fetched, total: de.total };
    }
  }

  return (
    <Paper variant='outlined' sx={{ p: 2, width: '100%', maxWidth: '72rem' }} data-testid='progress-panel'>
      <Stack spacing={1.5}>
        <Stack direction='row' spacing={1}>
          {PHASES.map((p, i) => {
            const isDone = !hasError && doneEvent;
            const isErrorPhase = hasError && i === phaseIdx;
            const isPast = i < phaseIdx;
            const isCurrent = i === phaseIdx;
            const marker = isDone || isPast ? '✓' : isErrorPhase ? '✗' : isCurrent ? '⟳' : '·';
            const color: 'success' | 'error' | 'info' | 'default' =
              isDone || isPast ? 'success' : isErrorPhase ? 'error' : isCurrent ? 'info' : 'default';
            return <Chip key={p.key} label={`${marker} ${p.label}`} color={color} size='small' />;
          })}
        </Stack>

        {criteriaEvent && (
          <Typography variant='caption' color='text.secondary' noWrap>
            {`${criteriaEvent.criteria.operation} · ${criteriaEvent.criteria.propertyType} · ${criteriaEvent.criteria.barrios.join(', ') || 'sin zona'} · ${criteriaEvent.criteria.currency}${criteriaEvent.criteria.requirements
              .filter((r) => r.kind === 'numeric')
              .map((r) => ` ${r.label}`)
              .join('')}`}
          </Typography>
        )}

        {adapters.size > 0 && (
          <Stack direction='row' spacing={1} alignItems='center'>
            <Typography variant='caption'>Portales:</Typography>
            {[...adapters.entries()].map(([portal, a]) => (
              <Chip
                key={portal}
                size='small'
                color={ADAPTER_COLOR[a.status]}
                label={`${portal}${a.count !== undefined ? ` (${a.count})` : ''}${a.status === 'blocked' ? ' ⚠ bloqueado' : ''}`}
              />
            ))}
          </Stack>
        )}

        {detailProgress && (
          <Typography variant='caption' color='text.secondary'>
            Detalle: {detailProgress.fetched}/{detailProgress.total} páginas
          </Typography>
        )}

        {gateResult && (
          <Typography variant='caption' color='text.secondary'>
            Gate numérico: {gateResult.survived}/{gateResult.total} pasaron
          </Typography>
        )}

        {evals.size > 0 && (
          <Stack direction='row' spacing={0.5} flexWrap='wrap' useFlexGap>
            {[...evals.entries()].map(([key, { status, detail }]) => (
              <Chip
                key={key}
                size='small'
                variant='outlined'
                color={AGENT_COLOR[status]}
                label={`${key.substring(0, 8)}… r${key.split('#')[1] ?? ''}`}
                title={status === 'error' ? detail : undefined}
              />
            ))}
          </Stack>
        )}

        {tokens && (
          <Stack spacing={0.5}>
            <Typography variant='caption'>
              Tokens: {tokens.total.toLocaleString()} / {tokens.budget.toLocaleString()}
            </Typography>
            <LinearProgress variant='determinate' value={Math.min(100, (tokens.total / tokens.budget) * 100)} />
          </Stack>
        )}

        {events
          .filter((e): e is ErrorEvent => e.type === 'error')
          .map((e, i) => (
            <Typography key={i} color='error' variant='body2'>
              {e.message}
            </Typography>
          ))}
      </Stack>
    </Paper>
  );
};
