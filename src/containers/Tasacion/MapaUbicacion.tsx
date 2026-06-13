'use client';

import { useEffect, useRef } from 'react';
import 'leaflet/dist/leaflet.css';
import type { UbicacionInfo } from '~/types';

type Props = { ubicacion: UbicacionInfo };

export const MapaUbicacion = ({ ubicacion }: Props) => {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let map: import('leaflet').Map | null = null;
    let cancelled = false;
    void import('leaflet').then((L) => {
      if (cancelled || !ref.current) return;
      map = L.map(ref.current, { zoomControl: false, attributionControl: true }).setView(
        [ubicacion.lat, ubicacion.lon],
        16,
      );
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors',
        crossOrigin: 'anonymous', // necesario para exportar el canvas sin taint
        maxZoom: 19,
      }).addTo(map);
      L.circleMarker([ubicacion.lat, ubicacion.lon], {
        radius: 9,
        color: '#d32f2f',
        fillColor: '#d32f2f',
        fillOpacity: 0.85,
      }).addTo(map);
    });
    return () => {
      cancelled = true;
      map?.remove();
    };
  }, [ubicacion.lat, ubicacion.lon]);

  return <div ref={ref} style={{ width: '100%', height: '220px', borderRadius: 8 }} data-testid='mapa-ubicacion' />;
};
