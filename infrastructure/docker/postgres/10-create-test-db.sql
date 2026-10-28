-- Runs once, on first start of an empty data volume.
-- A separate database for the test suite (it drops and rebuilds its schema).
CREATE DATABASE heimdall_test OWNER heimdall;
