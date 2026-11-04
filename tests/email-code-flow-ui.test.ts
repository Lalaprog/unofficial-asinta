// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  replace:vi.fn(), refresh:vi.fn(), user:null as null | {id:string; email:string; role:'founder'|'supervisor'},
  assurance:'signed_out' as 'signed_out'|'ready'|'required', decision:false, role:'founder' as 'founder'|'supervisor',
  codeVerify:vi.fn(), mfaVerify:vi.fn(), factors:vi.fn(), update:vi.fn(), login:vi.fn(), logout:vi.fn(), refreshAssurance:vi.fn(),
}));
vi.mock('next/navigation', () => ({useRouter:() => ({replace:mock.replace,refresh:mock.refresh})}));
vi.mock('@/lib/auth/authContext', () => ({useAuth:() => ({
  login:mock.login, logout:mock.logout, user:mock.user, assurance:mock.assurance,
  isLoading:false, refreshAssurance:mock.refreshAssurance,
})}));
vi.mock('@/lib/supabase/client', () => ({createClient:() => ({
  rpc:async () => ({data:mock.decision,error:null}),
  auth:{verifyOtp:mock.codeVerify, signOut:mock.logout, mfa:{listFactors:mock.factors,challengeAndVerify:mock.mfaVerify}},
  from:() => ({select:() => ({eq:() => ({maybeSingle:async () => ({data:{role:mock.role},error:null})})})}),
})}));
import LoginPage from '@/app/page';
import RecoveryChoicePage from '@/app/recovery/page';
import { RECOVERY_CHOICE_KEY } from '@/lib/auth/recovery';

beforeEach(() => {
  vi.clearAllMocks(); process.env.NEXT_PUBLIC_EMAIL_CODE_SIGNIN_ENABLED='true';
  mock.user=null; mock.assurance='signed_out'; mock.decision=false; mock.role='founder';
  mock.codeVerify.mockResolvedValue({data:{user:{id:'user-1'},session:{access_token:'synthetic'}},error:null});
  mock.mfaVerify.mockImplementation(async()=>{mock.decision=true;return {error:null}});
  mock.factors.mockResolvedValue({data:{totp:[{id:'factor-1',status:'verified'}]},error:null});
  mock.refreshAssurance.mockResolvedValue({ok:true}); mock.logout.mockResolvedValue(undefined);
  window.sessionStorage.clear(); document.cookie=`${RECOVERY_CHOICE_KEY}=; Path=/; Max-Age=0`;
  vi.stubGlobal('fetch',vi.fn(async () => new Response(JSON.stringify({ok:true,message:'If this email belongs to a BALE account, a sign-in code may arrive shortly.'}),{status:200})));
});
afterEach(() => {cleanup();vi.unstubAllGlobals(); delete process.env.NEXT_PUBLIC_EMAIL_CODE_SIGNIN_ENABLED;});

describe('email-code sign-in interface', () => {
  for (const role of ['founder','supervisor'] as const) {
    it(`requests a code and requires an enrolled ${role} authenticator before the password choice`, async () => {
      mock.role=role; render(React.createElement(LoginPage));
      fireEvent.click(screen.getByText('Forgot your password? Sign in with an email code'));
      fireEvent.change(screen.getByLabelText('Work Email'),{target:{value:'person@example.test'}});
      fireEvent.click(screen.getByText('Send sign-in code'));
      await screen.findByLabelText('Email Sign-In Code');
      fireEvent.change(screen.getByLabelText('Email Sign-In Code'),{target:{value:'12345678'}});
      fireEvent.click(screen.getByText('Verify sign-in code'));
      await screen.findByLabelText('6-Digit Authenticator Code');
      expect(mock.replace).not.toHaveBeenCalled();
      expect(mock.codeVerify).toHaveBeenCalledWith({email:'person@example.test',token:'12345678',type:'email'});
      fireEvent.change(screen.getByLabelText('6-Digit Authenticator Code'),{target:{value:'123456'}});
      fireEvent.click(screen.getByText('Verify & Open'));
      await waitFor(()=>expect(mock.replace).toHaveBeenCalledWith('/recovery'));
    });
  }
  it('opens the password choice for an unenrolled account without asking for MFA', async () => {
    mock.decision=true; mock.role='supervisor';
    render(React.createElement(LoginPage));
    fireEvent.click(screen.getByText('Forgot your password? Sign in with an email code'));
    fireEvent.change(screen.getByLabelText('Work Email'),{target:{value:'person@example.test'}});
    fireEvent.click(screen.getByText('Send sign-in code'));
    await screen.findByLabelText('Email Sign-In Code');
    fireEvent.change(screen.getByLabelText('Email Sign-In Code'),{target:{value:'12345678'}});
    fireEvent.click(screen.getByText('Verify sign-in code'));
    await waitFor(()=>expect(mock.replace).toHaveBeenCalledWith('/recovery'));
    expect(mock.factors).not.toHaveBeenCalled();
  });
  it('does not proceed when an email code is invalid, expired or already used', async () => {
    mock.codeVerify.mockResolvedValue({data:{user:null,session:null},error:{message:'expired'}});
    render(React.createElement(LoginPage));
    fireEvent.click(screen.getByText('Forgot your password? Sign in with an email code'));
    fireEvent.change(screen.getByLabelText('Work Email'),{target:{value:'person@example.test'}});
    fireEvent.click(screen.getByText('Send sign-in code'));
    await screen.findByLabelText('Email Sign-In Code');
    fireEvent.change(screen.getByLabelText('Email Sign-In Code'),{target:{value:'12345678'}});
    fireEvent.click(screen.getByText('Verify sign-in code'));
    await screen.findByText('The code is invalid or expired. Please request a new code and try again.');
    expect(mock.factors).not.toHaveBeenCalled(); expect(mock.replace).not.toHaveBeenCalled();
  });
  it('does not proceed when the factor lookup is unavailable', async () => {
    mock.factors.mockResolvedValue({data:null,error:new Error('down')});
    render(React.createElement(LoginPage));
    fireEvent.click(screen.getByText('Forgot your password? Sign in with an email code'));
    fireEvent.change(screen.getByLabelText('Work Email'),{target:{value:'person@example.test'}});
    fireEvent.click(screen.getByText('Send sign-in code'));
    await screen.findByLabelText('Email Sign-In Code');
    fireEvent.change(screen.getByLabelText('Email Sign-In Code'),{target:{value:'12345678'}});
    fireEvent.click(screen.getByText('Verify sign-in code'));
    await screen.findByText('Could not verify your account security. Please retry or sign out.');
    expect(mock.replace).not.toHaveBeenCalled();
  });
  it('resumes an existing incomplete session after a page reload', async () => {
    mock.user={id:'user-1',email:'user@example.test',role:'supervisor'}; mock.assurance='required';
    render(React.createElement(LoginPage));
    expect(await screen.findByLabelText('6-Digit Authenticator Code')).toBeTruthy();
    expect(mock.replace).not.toHaveBeenCalled();
  });
  it('offers the recovery choice only after session assurance', async () => {
    mock.user={id:'user-1',email:'user@example.test',role:'supervisor'}; mock.assurance='ready';
    render(React.createElement(RecoveryChoicePage));
    expect(screen.getByText('Change password now')).toBeTruthy();
    fireEvent.click(screen.getByText('Not now — continue'));
    expect(mock.replace).toHaveBeenCalledWith('/attendance');
  });
  it('lets a verified Founder change the password now before continuing', async () => {
    mock.user={id:'user-1',email:'user@example.test',role:'founder'}; mock.assurance='ready';
    render(React.createElement(RecoveryChoicePage));
    fireEvent.click(screen.getByText('Change password now'));
    fireEvent.change(screen.getByLabelText('New password'),{target:{value:'Secure12345'}});
    fireEvent.change(screen.getByLabelText('Confirm new password'),{target:{value:'Secure12345'}});
    fireEvent.click(screen.getByText('Save and continue'));
    await waitFor(()=>expect(mock.replace).toHaveBeenCalledWith('/dashboard'));
    expect(fetch).toHaveBeenCalledWith('/api/auth/recovery-password',expect.objectContaining({method:'POST',body:JSON.stringify({newPassword:'Secure12345'})}));
  });
  it('does not show the recovery form to an unverified session', async () => {
    mock.user={id:'user-1',email:'user@example.test',role:'founder'}; mock.assurance='required';
    render(React.createElement(RecoveryChoicePage));
    await waitFor(()=>expect(mock.replace).toHaveBeenCalledWith('/?redirect_to=%2Frecovery'));
    expect(screen.queryByText('Change password now')).toBeNull();
  });
});
