//! Error constructors with the board's wire codes.
use crate::protocol::RpcError;

pub(crate) fn invalid_argument(msg: impl Into<String>) -> RpcError {
    RpcError::new("invalid_argument", msg.into())
}

pub(crate) fn not_found(msg: impl Into<String>) -> RpcError {
    RpcError::new("not_found", msg.into())
}

pub(crate) fn internal_error(msg: impl Into<String>) -> RpcError {
    RpcError::new("internal_error", msg.into())
}

pub(crate) fn method_not_found(method: &str) -> RpcError {
    RpcError::new("method_not_found", format!("Unknown method: {method}"))
}

pub(crate) fn from_sqlite(err: rusqlite::Error) -> RpcError {
    internal_error(format!("storage failure: {err}"))
}
