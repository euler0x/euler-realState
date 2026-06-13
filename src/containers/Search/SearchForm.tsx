'use client';

import { useState } from 'react';
import SwapHorizIcon from '@mui/icons-material/SwapHoriz';
import { Button, Chip, IconButton, MenuItem, Select, Stack, TextField, Tooltip, Typography } from '@mui/material';
import type { Requirement, SearchCriteria, SearchParams } from '~/types';

const DEPTHS = [
  { replicas: 1, label: 'Económico (1× por aviso)' },
  { replicas: 2, label: 'Medio (2×)' },
  { replicas: 4, label: 'Profundo (4×)' },
];
const BUDGETS = [
  { value: 200_000, label: '200k tokens' },
  { value: 500_000, label: '500k tokens' },
  { value: 1_500_000, label: '1.5M tokens' },
];

type Props = {
  disabled: boolean;
  onSubmit: (params: SearchParams) => void;
};

export const SearchForm = ({ disabled, onSubmit }: Props) => {
  const [description, setDescription] = useState('');
  const [replicas, setReplicas] = useState(1);
  const [tokenBudget, setTokenBudget] = useState(500_000);
  const [criteria, setCriteria] = useState<SearchCriteria | null>(null);
  const [interpreting, setInterpreting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const interpret = async () => {
    setInterpreting(true);
    setError(null);
    try {
      const res = await fetch('/api/intake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: description.trim() }),
      });
      const data = (await res.json()) as { criteria?: SearchCriteria; error?: string };
      if (!res.ok || !data.criteria) throw new Error(data.error ?? 'No se pudo interpretar');
      setCriteria(data.criteria);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'error');
    } finally {
      setInterpreting(false);
    }
  };

  const toggleHardness = (id: string) =>
    setCriteria((c) =>
      c
        ? {
            ...c,
            requirements: c.requirements.map((r) =>
              r.id === id ? { ...r, hardness: r.hardness === 'must' ? 'nice' : 'must' } : r,
            ),
          }
        : c,
    );

  const patchCriteria = (patch: Partial<SearchCriteria>) => setCriteria((c) => (c ? { ...c, ...patch } : c));

  return (
    <Stack spacing={2} width='100%' maxWidth='72rem'>
      <textarea
        style={{ width: '100%', minHeight: '8rem', fontFamily: 'inherit', fontSize: '1rem', padding: '0.75rem' }}
        placeholder='Describí el inmueble que buscás (cuanto más detalle, mejor)'
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        disabled={disabled}
        data-testid='description-input'
      />

      {!criteria && (
        <Button
          variant='outlined'
          disabled={disabled || interpreting || description.trim().length < 30}
          onClick={interpret}
        >
          {interpreting ? 'Interpretando…' : 'Interpretar requisitos'}
        </Button>
      )}
      {error && (
        <Typography color='error' variant='body2'>
          {error}
        </Typography>
      )}

      {criteria && (
        <Stack spacing={1.5}>
          <Typography variant='subtitle2'>
            Tu búsqueda, interpretada — revisá operación/zona y clickeá un requisito para cambiar must↔nice:
          </Typography>
          <Stack direction='row' spacing={1} flexWrap='wrap' useFlexGap alignItems='center'>
            <Select
              value={criteria.operation}
              onChange={(e) => patchCriteria({ operation: e.target.value as SearchCriteria['operation'] })}
              disabled={disabled}
              size='small'
              data-testid='operation-select'
            >
              <MenuItem value='venta'>Venta</MenuItem>
              <MenuItem value='alquiler'>Alquiler</MenuItem>
            </Select>
            <Select
              value={criteria.propertyType}
              onChange={(e) => patchCriteria({ propertyType: e.target.value as SearchCriteria['propertyType'] })}
              disabled={disabled}
              size='small'
            >
              <MenuItem value='departamento'>Departamento</MenuItem>
              <MenuItem value='casa'>Casa</MenuItem>
              <MenuItem value='ph'>PH</MenuItem>
            </Select>
            <Select
              value={criteria.currency}
              onChange={(e) => patchCriteria({ currency: e.target.value as SearchCriteria['currency'] })}
              disabled={disabled}
              size='small'
            >
              <MenuItem value='USD'>USD</MenuItem>
              <MenuItem value='ARS'>ARS</MenuItem>
            </Select>
            <TextField
              size='small'
              label='Barrios (coma)'
              value={criteria.barrios.join(', ')}
              onChange={(e) =>
                patchCriteria({
                  barrios: e.target.value
                    .split(',')
                    .map((b) => b.trim())
                    .filter(Boolean),
                })
              }
              disabled={disabled}
              sx={{ flex: 1, minWidth: '12rem' }}
            />
          </Stack>
          <Stack direction='row' spacing={0.5} flexWrap='wrap' useFlexGap>
            {criteria.requirements.map((r: Requirement) => (
              <Tooltip key={r.id} title={r.hardness === 'must' ? 'Innegociable (filtra)' : 'Deseable (rankea)'}>
                <Chip
                  size='small'
                  color={r.hardness === 'must' ? 'error' : 'default'}
                  variant={r.hardness === 'must' ? 'filled' : 'outlined'}
                  label={`${r.hardness === 'must' ? '⛔' : '⭐'} ${r.label}`}
                  onClick={() => !disabled && toggleHardness(r.id)}
                  icon={<SwapHorizIcon />}
                />
              </Tooltip>
            ))}
          </Stack>
          <Stack direction='row' spacing={2} alignItems='center'>
            <Select
              value={replicas}
              onChange={(e) => setReplicas(Number(e.target.value))}
              disabled={disabled}
              size='small'
            >
              {DEPTHS.map((d) => (
                <MenuItem key={d.replicas} value={d.replicas}>
                  {d.label}
                </MenuItem>
              ))}
            </Select>
            <Select
              value={tokenBudget}
              onChange={(e) => setTokenBudget(Number(e.target.value))}
              disabled={disabled}
              size='small'
            >
              {BUDGETS.map((b) => (
                <MenuItem key={b.value} value={b.value}>
                  {b.label}
                </MenuItem>
              ))}
            </Select>
            <Button
              variant='contained'
              disabled={disabled}
              data-testid='search-button'
              onClick={() => onSubmit({ description: description.trim(), replicas, tokenBudget, criteria })}
            >
              Buscar
            </Button>
            <IconButton size='small' onClick={() => setCriteria(null)} disabled={disabled} title='Volver a interpretar'>
              <SwapHorizIcon />
            </IconButton>
          </Stack>
        </Stack>
      )}
    </Stack>
  );
};
