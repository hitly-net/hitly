"""
HITLy resume signature verification for LangGraph.

Verifies that resume came from HITLy using HMAC-SHA256 signature.
"""

import hashlib
import hmac
import json
import os
import time
from typing import Any, Dict, Optional


HITLY_RESUME_CLAIM_VERSION = 1
HITLY_RESUME_TTL_SECONDS = 5 * 60


class HitlyResumeError(Exception):
    """Raised when HITLy resume verification fails."""
    pass


def stable_json(value: Any) -> str:
    """
    Stable JSON serialization (matches TypeScript `stable` function).
    
    Keys are sorted, no whitespace.
    """
    if value is None or isinstance(value, (bool, int, float, str)):
        return json.dumps(value, separators=(',', ':'), sort_keys=True)
    if isinstance(value, list):
        items = ','.join(stable_json(item) for item in value)
        return f'[{items}]'
    if isinstance(value, dict):
        keys = sorted(value.keys())
        items = ','.join(f'{json.dumps(k)}:{stable_json(value[k])}' for k in keys)
        return f'{{{items}}}'
    raise ValueError(f'Cannot serialize {type(value)}')


def hmac_hex(secret: str, payload: str) -> str:
    """HMAC-SHA256 hex digest."""
    return hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()


def verify_hitly_resume(
    resume_data: Any,
    *,
    secret: Optional[str] = None,
    run_id: Optional[str] = None,
    required: bool = True,
) -> None:
    """
    Verify HITLy resume proof.
    
    Args:
        resume_data: The resume data from Command(resume=...) 
        secret: HITLY_RESUME_SECRET (defaults to env var)
        run_id: Expected runId (threadId) to match
        required: If True, require proof when secret is set
        
    Raises:
        HitlyResumeError: If verification fails
    """
    secret = secret or os.getenv('HITLY_RESUME_SECRET', '')
    required = required if secret else False
    
    if not secret:
        if required:
            raise HitlyResumeError(
                'HITLY_RESUME_SECRET is not set; copy it from the HITLy project Config page.'
            )
        return
    
    if not isinstance(resume_data, dict):
        raise HitlyResumeError('HITLy resume proof is missing; reject spoofed resume.')
    
    claim = resume_data.get('hitly')
    if not claim or not isinstance(claim, dict):
        raise HitlyResumeError('HITLy resume proof is missing; reject spoofed resume.')
    
    # Validate claim structure
    version = claim.get('v')
    sig = claim.get('sig')
    exp = claim.get('exp')
    claimed_run_id = claim.get('runId')
    
    if version != HITLY_RESUME_CLAIM_VERSION or not isinstance(sig, str):
        raise HitlyResumeError('HITLy resume proof is invalid.')
    
    if not isinstance(exp, (int, float)) or exp * 1000 < time.time() * 1000:
        raise HitlyResumeError('HITLy resume proof has expired.')
    
    if run_id and claimed_run_id != run_id:
        raise HitlyResumeError('HITLy resume proof runId does not match this run.')
    
    # Verify signature
    unsigned_claim = {k: v for k, v in claim.items() if k != 'sig'}
    data = {k: v for k, v in resume_data.items() if k != 'hitly'}
    
    payload = f'{stable_json(unsigned_claim)}.{stable_json(data)}'
    expected = hmac_hex(secret, payload)
    
    # Timing-safe comparison
    if not hmac.compare_digest(expected, sig):
        raise HitlyResumeError('HITLy resume proof signature does not match.')
