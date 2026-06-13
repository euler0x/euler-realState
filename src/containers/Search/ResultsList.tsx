'use client';

import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { Accordion, AccordionDetails, AccordionSummary, Chip, Link, Paper, Stack, Typography } from '@mui/material';
import type { EvaluatedListing, SearchCriteria, SearchOutput } from '~/types';

type Props = { output: SearchOutput; criteria?: SearchCriteria };

export const ResultsList = ({ output, criteria }: Props) => {
  const label = (id: string) => criteria?.requirements.find((r) => r.id === id)?.label ?? id;
  const isMust = (id: string) => criteria?.requirements.find((r) => r.id === id)?.hardness === 'must';

  return (
    <Stack spacing={1.5} width='100%' maxWidth='72rem' data-testid='results'>
      <Typography variant='h6'>
        {output.survivors.length} avisos pasaron tus filtros{output.degraded ? ' — ⚠ degradado' : ''}
      </Typography>

      {(output.exclusions.length > 0 || output.unevaluable.length > 0) && (
        <Typography variant='caption' color='text.secondary'>
          Excluidos: {output.exclusions.map((b) => `${b.count} (${b.reason})`).join(' · ')}
          {output.unevaluable.length > 0 ? ` · ⚠ ${output.unevaluable.length} no se pudieron evaluar` : ''}
        </Typography>
      )}

      {output.survivors.map((r: EvaluatedListing) => (
        <Paper key={r.listing.id} variant='outlined' sx={{ p: 2 }}>
          <Stack spacing={1}>
            <Stack direction='row' spacing={1} alignItems='center'>
              <Chip size='small' color='success' label={`${Math.round(r.niceScore * 100)}% deseables`} />
              {r.unconfirmedMusts > 0 && (
                <Chip
                  size='small'
                  color='info'
                  variant='outlined'
                  label={`❓ ${r.unconfirmedMusts} must sin confirmar`}
                />
              )}
              {r.redFlag && <Chip size='small' color='warning' label='⚠ red flag' />}
              {r.partialData && <Chip size='small' variant='outlined' label='datos parciales' />}
              <Link href={r.listing.url} target='_blank' rel='noopener noreferrer'>
                {r.listing.title}
              </Link>
            </Stack>
            <Typography variant='body2'>
              {r.listing.price.currency} {r.listing.price.amount.toLocaleString()} · {r.listing.barrio}
              {r.listing.ambientes ? ` · ${r.listing.ambientes} amb` : ''}
              {r.listing.m2 ? ` · ${r.listing.m2} m²` : ''}
            </Typography>
            <Accordion disableGutters variant='outlined'>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Typography variant='caption'>Requisitos verificados (con evidencia)</Typography>
              </AccordionSummary>
              <AccordionDetails>
                <Stack spacing={0.5}>
                  {r.requirementResults.map((v) => (
                    <Typography key={v.requirementId} variant='caption'>
                      {v.verdict === 'met' ? '✅' : v.verdict === 'not_met' ? '❌' : '❓'}{' '}
                      <b>
                        {isMust(v.requirementId) ? '⛔' : '⭐'} {label(v.requirementId)}
                      </b>
                      {v.evidence ? ` → "${v.evidence}"` : ' → sin mención'}
                    </Typography>
                  ))}
                </Stack>
              </AccordionDetails>
            </Accordion>
          </Stack>
        </Paper>
      ))}
    </Stack>
  );
};
