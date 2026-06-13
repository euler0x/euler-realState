'use client';

import { useRef, useState } from 'react';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Button,
  Chip,
  CircularProgress,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableRow,
  Typography,
} from '@mui/material';
import { toPng } from 'html-to-image';
import type { TasacionInput, TasacionResult } from '~/types';
import { HistorialTasaciones } from './HistorialTasaciones';
import { MapaUbicacion } from './MapaUbicacion';

const CONF_COLOR: Record<TasacionResult['confianza'], 'success' | 'warning' | 'error'> = {
  alta: 'success',
  media: 'warning',
  baja: 'error',
};

const PLACEHOLDER = `Describí el inmueble. Ideal: "Departamento de 3 ambientes en Caballito, Pedro Goyena 600, piso 4 al frente con ascensor, 75 m² cubiertos + balcón de 6 m², 20 años, muy buen estado, edificio de categoría con pileta y sum, con cochera."`;

export const TasacionPage = () => {
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<{ input: TasacionInput; result: TasacionResult } | null>(null);
  const [guardada, setGuardada] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const cardRef = useRef<HTMLDivElement>(null);

  const tasarInmueble = async () => {
    setLoading(true);
    setError(null);
    setData(null);
    setGuardada(false);
    try {
      const res = await fetch('/api/tasacion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: description.trim() }),
      });
      const json = (await res.json()) as { input?: TasacionInput; result?: TasacionResult; error?: string };
      if (!res.ok || !json.result || !json.input) throw new Error(json.error ?? 'No se pudo tasar');
      setData({ input: json.input, result: json.result });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'error');
    } finally {
      setLoading(false);
    }
  };

  const guardar = async () => {
    if (!data) return;
    const res = await fetch('/api/tasaciones', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: description.trim(), input: data.input, result: data.result }),
    });
    if (res.ok) {
      setGuardada(true);
      setRefreshKey((k) => k + 1);
    }
  };

  const abrirGuardada = async (id: string) => {
    const res = await fetch(`/api/tasaciones/${id}`);
    if (!res.ok) return;
    const t = (await res.json()) as { description: string; input: TasacionInput; result: TasacionResult };
    setDescription(t.description);
    setData({ input: t.input, result: t.result });
    setGuardada(true);
    setError(null);
  };

  const exportarPng = async () => {
    if (!cardRef.current) return;
    try {
      const url = await toPng(cardRef.current, { cacheBust: true, backgroundColor: '#ffffff' });
      const a = document.createElement('a');
      a.href = url;
      a.download = `tasacion-${new Date().toISOString().slice(0, 10)}-${data?.input.barrio ?? 'caba'}.png`;
      a.click();
    } catch {
      setError('No se pudo exportar la imagen (mapa con CORS) — usá imprimir como alternativa.');
    }
  };

  const r = data?.result;
  const i = data?.input;

  return (
    <Stack spacing={2} width='100%' maxWidth='72rem' py={4}>
      <textarea
        style={{ width: '100%', minHeight: '8rem', fontFamily: 'inherit', fontSize: '1rem', padding: '0.75rem' }}
        placeholder={PLACEHOLDER}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        disabled={loading}
        data-testid='tasacion-input'
      />
      <Button
        variant='contained'
        disabled={loading || description.trim().length < 30}
        onClick={tasarInmueble}
        data-testid='tasacion-button'
      >
        {loading ? (
          <>
            <CircularProgress size={18} sx={{ mr: 1 }} /> Tasando…
          </>
        ) : (
          'Tasar'
        )}
      </Button>
      {error && (
        <Typography color='error' variant='body2'>
          {error}
        </Typography>
      )}

      {r && i && (
        <Paper ref={cardRef} variant='outlined' sx={{ p: 3 }} data-testid='tasacion-result'>
          <Stack spacing={2}>
            <Stack direction='row' spacing={2} alignItems='baseline'>
              <Typography variant='h4'>USD {r.valorEstimadoUsd.toLocaleString('es-AR')}</Typography>
              <Typography variant='body2' color='text.secondary'>
                rango {r.rangoUsd[0].toLocaleString('es-AR')} – {r.rangoUsd[1].toLocaleString('es-AR')}
              </Typography>
              <Chip size='small' color={CONF_COLOR[r.confianza]} label={`confianza ${r.confianza}`} />
            </Stack>

            <Stack direction='row' spacing={0.5} flexWrap='wrap' useFlexGap>
              <Chip size='small' variant='outlined' label={`${i.barrio ?? 'sin barrio'}`} />
              <Chip size='small' variant='outlined' label={`${r.superficieHomogeneizada} m² hom.`} />
              {i.piso !== null && (
                <Chip size='small' variant='outlined' label={i.piso === 0 ? 'PB' : `piso ${i.piso}`} />
              )}
              {i.antiguedadAnios !== null && (
                <Chip size='small' variant='outlined' label={`${i.antiguedadAnios} años`} />
              )}
              {i.tieneCochera && <Chip size='small' variant='outlined' label='cochera' />}
              {i.aEstrenar && <Chip size='small' variant='outlined' label='a estrenar' />}
            </Stack>

            {r.ubicacion && <MapaUbicacion ubicacion={r.ubicacion} />}
            {r.ubicacion && r.ubicacion.avisos > 0 && (
              <Typography variant='caption' color='text.secondary'>
                Micro-zona: ×{r.ubicacion.multiplicador.toFixed(2)} vs media del barrio ({r.ubicacion.avisos} avisos
                históricos)
              </Typography>
            )}

            <Accordion disableGutters variant='outlined'>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Typography variant='caption'>Cómo se calculó (breakdown coeficiente por coeficiente)</Typography>
              </AccordionSummary>
              <AccordionDetails>
                <Table size='small'>
                  <TableBody>
                    {r.breakdown.map((b, idx) => (
                      <TableRow key={idx}>
                        <TableCell>{b.concepto}</TableCell>
                        <TableCell align='right'>
                          <b>{b.valor}</b>
                        </TableCell>
                        <TableCell sx={{ color: 'text.secondary' }}>{b.efecto ?? ''}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {r.supuestos.length > 0 && (
                  <Typography variant='caption' color='text.secondary' component='div' sx={{ mt: 1 }}>
                    Supuestos: {r.supuestos.join(' · ')}
                  </Typography>
                )}
              </AccordionDetails>
            </Accordion>

            {r.mejoras.length > 0 && (
              <Stack spacing={0.5} data-testid='mejoras'>
                <Typography variant='subtitle2'>Para mejorar esta tasación:</Typography>
                {r.mejoras.map((mj) => (
                  <Typography key={mj.campo} variant='caption'>
                    • {mj.sugerencia} <b>({mj.impacto})</b>
                  </Typography>
                ))}
              </Stack>
            )}

            <Typography variant='caption' color='text.secondary'>
              Estimación automática (±15%) basada en valores publicados de mercado ({r.fuentePrecios.fuente},{' '}
              {r.fuentePrecios.fecha}). No reemplaza una tasación profesional.
            </Typography>

            <Stack direction='row' spacing={1}>
              <Button
                size='small'
                variant='outlined'
                onClick={guardar}
                disabled={guardada}
                data-testid='guardar-button'
              >
                {guardada ? 'Guardada ✓' : 'Guardar'}
              </Button>
              <Button size='small' variant='outlined' onClick={exportarPng} data-testid='export-button'>
                Exportar PNG
              </Button>
            </Stack>
          </Stack>
        </Paper>
      )}

      <HistorialTasaciones refreshKey={refreshKey} onOpen={abrirGuardada} />
    </Stack>
  );
};
