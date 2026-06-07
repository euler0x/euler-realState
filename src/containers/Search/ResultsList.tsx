'use client';

import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { Accordion, AccordionDetails, AccordionSummary, Chip, Link, Paper, Stack, Typography } from '@mui/material';
import type { ScoredListing } from '~/types';

type Props = {
  results: ScoredListing[];
  degraded: boolean;
  partial: boolean;
};

export const ResultsList = ({ results, degraded, partial }: Props) => {
  return (
    <Stack spacing={1.5} width='100%' maxWidth='72rem' data-testid='results'>
      <Typography variant='h6'>
        {results.length} resultados con consenso
        {degraded ? ' — ⚠ degradado (pocos lentes respondieron)' : ''}
        {partial ? ' — ⚠ parcial (se agotó el presupuesto de tokens)' : ''}
      </Typography>
      {results.map((r) => (
        <Paper key={r.listing.id} variant='outlined' sx={{ p: 2 }}>
          <Stack spacing={1}>
            <Stack direction='row' spacing={1} alignItems='center'>
              <Chip size='small' color='success' label={`${r.matchedLenses}/${r.totalLenses} lentes`} />
              {r.redFlag && <Chip size='small' color='warning' label='⚠ red flag' />}
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
                <Typography variant='caption'>Por qué entró (votos por lente)</Typography>
              </AccordionSummary>
              <AccordionDetails>
                <Stack spacing={0.5}>
                  {r.reasons.map((reason, i) => (
                    <Typography key={i} variant='caption'>
                      <b>{reason.lens}</b> #{reason.replica} → {reason.verdict}: {reason.reason}
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
