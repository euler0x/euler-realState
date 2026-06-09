'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Stack } from '@mui/material';
import type { SearchCriteria, SearchEvent, SearchOutput, SearchParams } from '~/types';
import { ProgressPanel } from './ProgressPanel';
import { ResultsList } from './ResultsList';
import { SearchForm } from './SearchForm';

type Phase = 'idle' | 'running' | 'done';

export const SearchPage = () => {
  const [phase, setPhase] = useState<Phase>('idle');
  const [events, setEvents] = useState<SearchEvent[]>([]);
  const [results, setResults] = useState<SearchOutput | null>(null);
  const [criteria, setCriteria] = useState<SearchCriteria | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  const start = useCallback(async (params: SearchParams) => {
    // Close any existing EventSource before starting a new search
    if (sourceRef.current) {
      sourceRef.current.close();
      sourceRef.current = null;
    }

    setPhase('running');
    setEvents([]);
    setResults(null);
    setCriteria(null);

    const res = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      const { error } = (await res.json().catch(() => ({ error: 'error desconocido' }))) as { error: string };
      setEvents([{ type: 'error', message: error }]);
      setPhase('done');
      return;
    }
    const { id } = (await res.json()) as { id: string };

    const source = new EventSource(`/api/search/${id}/events`);
    sourceRef.current = source;

    source.onmessage = async (msg) => {
      const event = JSON.parse(msg.data as string) as SearchEvent;
      setEvents((prev) => [...prev, event]);

      if (event.type === 'done') {
        source.close();
        sourceRef.current = null;
        try {
          const data = (await (await fetch(`/api/search/${id}`)).json()) as {
            search?: { criteria?: SearchCriteria };
            results: SearchOutput | null;
          };
          setResults(data.results);
          setCriteria(data.search?.criteria ?? null);
        } catch {
          setEvents((prev) => [...prev, { type: 'error', message: 'No se pudieron cargar los resultados finales.' }]);
        } finally {
          setPhase('done');
        }
      } else if (event.type === 'error') {
        source.close();
        sourceRef.current = null;
        setPhase('done');
      }
    };

    source.onerror = () => {
      if (sourceRef.current !== source) return; // already handled done/error cleanly
      source.close();
      sourceRef.current = null;
      setPhase('done');
    };
  }, []);

  useEffect(() => {
    return () => {
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, []);

  return (
    <Stack spacing={3} alignItems='center' width='100%' py={4}>
      <SearchForm disabled={phase === 'running'} onSubmit={start} />
      {events.length > 0 && <ProgressPanel events={events} />}
      {results && <ResultsList output={results} criteria={criteria ?? undefined} />}
    </Stack>
  );
};
