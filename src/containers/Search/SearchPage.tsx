'use client';

import { useCallback, useRef, useState } from 'react';
import { Stack } from '@mui/material';
import type { ScoredListing, SearchEvent, SearchParams } from '~/types';
import { ProgressPanel } from './ProgressPanel';
import { ResultsList } from './ResultsList';
import { SearchForm } from './SearchForm';

type Phase = 'idle' | 'running' | 'done';

interface ResultsState {
  results: ScoredListing[];
  degraded: boolean;
  partial: boolean;
}

export const SearchPage = () => {
  const [phase, setPhase] = useState<Phase>('idle');
  const [events, setEvents] = useState<SearchEvent[]>([]);
  const [results, setResults] = useState<ResultsState | null>(null);
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
        const data = (await (await fetch(`/api/search/${id}`)).json()) as {
          results: { results: ScoredListing[]; degraded: boolean } | null;
        };
        setResults({
          results: data.results?.results ?? [],
          degraded: data.results?.degraded ?? false,
          partial: event.partial,
        });
        setPhase('done');
      } else if (event.type === 'error') {
        source.close();
        sourceRef.current = null;
        setPhase('done');
      }
    };

    source.onerror = () => {
      source.close();
      sourceRef.current = null;
      setPhase('done');
    };
  }, []);

  return (
    <Stack spacing={3} alignItems='center' width='100%' py={4}>
      <SearchForm disabled={phase === 'running'} onSubmit={start} />
      {events.length > 0 && <ProgressPanel events={events} />}
      {results && <ResultsList results={results.results} degraded={results.degraded} partial={results.partial} />}
    </Stack>
  );
};
