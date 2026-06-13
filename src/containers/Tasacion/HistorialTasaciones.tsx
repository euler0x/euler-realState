'use client';

import { useEffect, useState } from 'react';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Chip,
  List,
  ListItemButton,
  ListItemText,
  Typography,
} from '@mui/material';

interface Item {
  id: string;
  fecha: string;
  titulo: string;
  valorEstimadoUsd: number;
  confianza: string;
}

type Props = {
  refreshKey: number; // se incrementa al guardar para refrescar la lista
  onOpen: (id: string) => void;
};

export const HistorialTasaciones = ({ refreshKey, onOpen }: Props) => {
  const [items, setItems] = useState<Item[]>([]);

  useEffect(() => {
    void fetch('/api/tasaciones')
      .then((r) => r.json())
      .then((d: { tasaciones?: Item[] }) => setItems(d.tasaciones ?? []))
      .catch(() => setItems([]));
  }, [refreshKey]);

  if (items.length === 0) return null;
  return (
    <Accordion disableGutters variant='outlined' sx={{ width: '100%' }}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Typography variant='caption'>Historial ({items.length})</Typography>
      </AccordionSummary>
      <AccordionDetails sx={{ p: 0 }}>
        <List dense>
          {items.map((t) => (
            <ListItemButton key={t.id} onClick={() => onOpen(t.id)}>
              <ListItemText
                primary={`${t.titulo} — USD ${t.valorEstimadoUsd.toLocaleString('es-AR')}`}
                secondary={t.fecha}
              />
              <Chip size='small' label={t.confianza} />
            </ListItemButton>
          ))}
        </List>
      </AccordionDetails>
    </Accordion>
  );
};
