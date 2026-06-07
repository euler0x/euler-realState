'use client';

import { Chip, LinearProgress, Paper, Stack, Typography } from '@mui/material';
import type { AdapterEventStatus, AgentEventStatus, SearchEvent, SearchPhase } from '~/types';

const PHASES: { key: SearchPhase; label: string }[] = [
  { key: 'intake', label: 'Intake' },
  { key: 'acquisition', label: 'Adquisición' },
  { key: 'voting', label: 'Votación' },
  { key: 'consensus', label: 'Consenso' },
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
type AdapterEvent = { type: 'adapter'; portal: string; status: AdapterEventStatus; count?: number; detail?: string };
type AgentEvent = { type: 'agent'; lens: string; replica: number; status: AgentEventStatus };
type TokensEvent = { type: 'tokens'; total: number; budget: number };
type DoneEvent = { type: 'done'; resultCount: number; degraded: boolean; partial: boolean };
type ErrorEvent = { type: 'error'; message: string };

type Props = { events: SearchEvent[] };

export const ProgressPanel = ({ events }: Props) => {
  const currentPhase = [...events].reverse().find((e): e is PhaseEvent => e.type === 'phase');
  const phaseIdx = PHASES.findIndex((p) => p.key === currentPhase?.phase);
  const doneEvent = events.find((e): e is DoneEvent => e.type === 'done');

  const adapters = new Map<string, { status: AdapterEventStatus; count?: number; detail?: string }>();
  const agents = new Map<string, AgentEventStatus>();
  let tokens: { total: number; budget: number } | undefined;

  for (const e of events) {
    if (e.type === 'adapter') {
      const ae = e as AdapterEvent;
      adapters.set(ae.portal, { status: ae.status, count: ae.count, detail: ae.detail });
    }
    if (e.type === 'agent') {
      const age = e as AgentEvent;
      agents.set(`${age.lens}#${age.replica}`, age.status);
    }
    if (e.type === 'tokens') {
      const te = e as TokensEvent;
      tokens = { total: te.total, budget: te.budget };
    }
  }

  return (
    <Paper variant='outlined' sx={{ p: 2, width: '100%', maxWidth: '72rem' }} data-testid='progress-panel'>
      <Stack spacing={1.5}>
        <Stack direction='row' spacing={1}>
          {PHASES.map((p, i) => (
            <Chip
              key={p.key}
              label={`${i < phaseIdx || doneEvent ? '✓' : i === phaseIdx ? '⟳' : '·'} ${p.label}`}
              color={i < phaseIdx || doneEvent ? 'success' : i === phaseIdx ? 'info' : 'default'}
              size='small'
            />
          ))}
        </Stack>

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

        {agents.size > 0 && (
          <Stack direction='row' spacing={0.5} flexWrap='wrap' useFlexGap>
            {[...agents.entries()].map(([key, status]) => (
              <Chip key={key} size='small' variant='outlined' color={AGENT_COLOR[status]} label={key} />
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
