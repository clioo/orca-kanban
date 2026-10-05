//! The wire types the board shares with its web UI: the RPC error and the
//! Jira types (ported from Drogon's `drogon-protocol`).
use serde::{Deserialize, Serialize};
use std::fmt;

pub mod jira;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct RpcError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl RpcError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable: false,
        }
    }
}

impl fmt::Display for RpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for RpcError {}
