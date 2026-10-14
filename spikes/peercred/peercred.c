// Minimal N-API addon: getPeerCred(fd) -> { pid, uid, gid } using SO_PEERCRED.
#define _GNU_SOURCE
#include <node_api.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <errno.h>
#include <string.h>

static napi_value GetPeerCred(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int32_t fd = -1;
  if (argc < 1 || napi_get_value_int32(env, argv[0], &fd) != napi_ok) {
    napi_throw_type_error(env, NULL, "fd must be an int32");
    return NULL;
  }
  struct ucred cred;
  socklen_t len = sizeof(cred);
  if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &cred, &len) != 0) {
    napi_throw_error(env, strerror(errno), "getsockopt(SO_PEERCRED) failed");
    return NULL;
  }
  napi_value out, pid, uid, gid;
  napi_create_object(env, &out);
  napi_create_int32(env, (int32_t)cred.pid, &pid);
  napi_create_uint32(env, (uint32_t)cred.uid, &uid);
  napi_create_uint32(env, (uint32_t)cred.gid, &gid);
  napi_set_named_property(env, out, "pid", pid);
  napi_set_named_property(env, out, "uid", uid);
  napi_set_named_property(env, out, "gid", gid);
  return out;
}

NAPI_MODULE_INIT() {
  napi_value fn;
  napi_create_function(env, "getPeerCred", NAPI_AUTO_LENGTH, GetPeerCred, NULL, &fn);
  napi_set_named_property(env, exports, "getPeerCred", fn);
  return exports;
}
