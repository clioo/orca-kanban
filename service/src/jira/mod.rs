//! Jira data layer for the Tasks page (R17-A). Rust-daemon port of the
//! orca-drogon fork's `src/main/jira/**` client, storage and read-failure
//! behavior: site/account store in the daemon data dir, encrypted token
//! files, serialized per-site requests, cancellable searches, paged
//! project/create-metadata queries, and the fork's error taxonomy.
//! MIT Copyright (c) 2026 Lovecast Inc.

pub mod adf;
pub mod client;
pub mod identity;
pub mod mapping;
pub mod ops;
pub mod seal;
pub mod sites;

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use client::CancelFlag;
use sites::SiteStore;

/// Per-Engine Jira state: the site/token store, a connect serializer, one
/// request queue per site (the fork's bounded request pool, narrowed to
/// per-site serialization as the task mandates) and the in-flight search
/// registry keyed by renderer request id.
pub struct JiraState {
    pub sites: SiteStore,
    connect_lock: Mutex<()>,
    site_queues: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    in_flight: Mutex<HashMap<String, CancelFlag>>,
}

impl JiraState {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            sites: SiteStore::new(data_dir),
            connect_lock: Mutex::new(()),
            site_queues: Mutex::new(HashMap::new()),
            in_flight: Mutex::new(HashMap::new()),
        }
    }

    pub fn connect_lock(&self) -> &Mutex<()> {
        &self.connect_lock
    }

    /// The serialized request queue for one site: at most one in-flight
    /// Jira HTTP call per site, matching the fork's pool semantics from a
    /// single site's point of view.
    pub fn site_queue(&self, site_id: &str) -> Arc<Mutex<()>> {
        self.site_queues
            .lock()
            .unwrap()
            .entry(site_id.to_string())
            .or_default()
            .clone()
    }

    /// Register a renderer-chosen request id for a new search. Reusing an
    /// id means the renderer abandoned its previous attempt (the query
    /// changed), so the previous flag is cancelled — the fork's
    /// `JiraCancellableRequests.run`.
    pub fn register_in_flight(&self, request_id: &str) -> CancelFlag {
        let flag = CancelFlag::new();
        let mut in_flight = self.in_flight.lock().unwrap();
        if let Some(previous) = in_flight.insert(request_id.to_string(), flag.clone()) {
            previous.cancel();
        }
        flag
    }

    /// The fork's `cancel`: trip the flag of a live search so its curl
    /// child is killed. Returns whether a live search was cancelled.
    pub fn cancel_in_flight(&self, request_id: &str) -> bool {
        let in_flight = self.in_flight.lock().unwrap();
        if let Some(flag) = in_flight.get(request_id) {
            flag.cancel();
            true
        } else {
            false
        }
    }

    pub fn unregister_in_flight(&self, request_id: &str, flag: &CancelFlag) {
        let mut in_flight = self.in_flight.lock().unwrap();
        // Only remove our own registration: a superseding search may have
        // replaced it already (compare by Arc pointer, never flag value).
        if in_flight
            .get(request_id)
            .is_some_and(|current| Arc::ptr_eq(&current.0, &flag.0))
        {
            in_flight.remove(request_id);
        }
    }
}
