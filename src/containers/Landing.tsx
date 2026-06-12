'use client';

import { useState } from 'react';
import { Box, Tab, Tabs } from '@mui/material';
import { styled } from '@mui/material/styles';
import { DISCLAIMER_HEIGHT, SURROUND_HEIGHT } from '~/utils';
import { SearchPage } from './Search';
import { TasacionPage } from './Tasacion';

export const Landing = () => {
  const [tab, setTab] = useState(0);
  return (
    <LandingContainer>
      <Tabs value={tab} onChange={(_, v: number) => setTab(v)} sx={{ alignSelf: 'center' }}>
        <Tab label='Buscar' />
        <Tab label='Tasar' />
      </Tabs>
      {/* display:none (no unmount) para no matar una búsqueda SSE en curso al cambiar de tab */}
      <Box sx={{ display: tab === 0 ? 'flex' : 'none', flexDirection: 'column', alignItems: 'center', width: '100%' }}>
        <SearchPage />
      </Box>
      <Box sx={{ display: tab === 1 ? 'flex' : 'none', flexDirection: 'column', alignItems: 'center', width: '100%' }}>
        <TasacionPage />
      </Box>
    </LandingContainer>
  );
};

const LandingContainer = styled('div')({
  display: 'flex',
  flexDirection: 'column',
  minHeight: `calc(100vh - ${SURROUND_HEIGHT}rem - ${DISCLAIMER_HEIGHT}rem)`,
  padding: '0 8rem',
  alignItems: 'center',
  width: '100%',
});
