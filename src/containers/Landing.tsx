'use client';

import { styled } from '@mui/material/styles';
import { DISCLAIMER_HEIGHT, SURROUND_HEIGHT } from '~/utils';
import { SearchPage } from './Search';

export const Landing = () => {
  return (
    <LandingContainer>
      <SearchPage />
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
