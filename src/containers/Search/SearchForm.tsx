'use client';

import { useState } from 'react';
import { Button, MenuItem, Select, SelectChangeEvent, Slider, Stack, TextField, Typography } from '@mui/material';
import type { SearchParams } from '~/types';

const DEPTHS = [
  { replicas: 1, label: 'Económico — 6 agentes (1 por lente)' },
  { replicas: 2, label: 'Medio — 12 agentes (2 por lente)' },
  { replicas: 4, label: 'Profundo — 24 agentes (4 por lente)' },
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
  const [threshold, setThreshold] = useState(0.6);
  const [tokenBudget, setTokenBudget] = useState(500_000);

  const handleReplicasChange = (e: SelectChangeEvent<number>) => setReplicas(Number(e.target.value));
  const handleBudgetChange = (e: SelectChangeEvent<number>) => setTokenBudget(Number(e.target.value));
  const handleThresholdChange = (_: Event, v: number | number[]) => setThreshold(v as number);

  return (
    <Stack spacing={2} width='100%' maxWidth='72rem'>
      <TextField
        multiline
        minRows={5}
        label='Describí el inmueble que buscás (cuanto más detalle, mejor)'
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        disabled={disabled}
        inputProps={{ 'data-testid': 'description-input' }}
      />
      <Stack direction='row' spacing={2} alignItems='center'>
        <Select<number> value={replicas} onChange={handleReplicasChange} disabled={disabled} size='small'>
          {DEPTHS.map((d) => (
            <MenuItem key={d.replicas} value={d.replicas}>
              {d.label}
            </MenuItem>
          ))}
        </Select>
        <Select<number> value={tokenBudget} onChange={handleBudgetChange} disabled={disabled} size='small'>
          {BUDGETS.map((b) => (
            <MenuItem key={b.value} value={b.value}>
              {b.label}
            </MenuItem>
          ))}
        </Select>
        <Stack flex={1} px={2}>
          <Typography variant='caption'>Threshold de consenso: {Math.round(threshold * 100)}%</Typography>
          <Slider
            min={0.2}
            max={1}
            step={0.1}
            value={threshold}
            onChange={handleThresholdChange}
            disabled={disabled}
            size='small'
          />
        </Stack>
        <Button
          variant='contained'
          disabled={disabled || description.trim().length < 30}
          onClick={() => onSubmit({ description: description.trim(), replicas, threshold, tokenBudget })}
          data-testid='search-button'
        >
          Buscar
        </Button>
      </Stack>
    </Stack>
  );
};
