import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {Linking, Platform, StyleSheet, View} from 'react-native';
import {EventEmitter} from 'events';
import {WebView} from './WebView';
import {
  CUSTOM_USER_AGENT,
  DEFAULT_BASE_URL,
  PLAYER_ERROR,
  PLAYER_STATES,
} from './constants';
import {MAIN_SCRIPT} from './PlayerScripts';
import {deepComparePlayList} from './utils';

const YoutubeIframe = (props, ref) => {
  const {
    height,
    width,
    videoId,
    playList,
    play = false,
    mute = false,
    volume = 100,
    webViewStyle,
    webViewProps,
    useLocalHTML,
    baseUrlOverride,
    playbackRate = 1,
    contentScale = 1.0,
    onError = _err => {},
    onReady = _event => {},
    playListStartIndex = 0,
    initialPlayerParams,
    allowWebViewZoom = false,
    forceAndroidAutoplay = false,
    onChangeState = _event => {},
    onFullScreenChange = _status => {},
    onPlaybackQualityChange = _quality => {},
    onPlaybackRateChange = _playbackRate => {},
  } = props;

  const [playerReady, setPlayerReady] = useState(false);
  const lastVideoIdRef = useRef(videoId);
  const lastPlayListRef = useRef(playList);
  const initialPlayerParamsRef = useRef(initialPlayerParams || {});

  const webViewRef = useRef(null);
  const eventEmitter = useRef(new EventEmitter());
  const executionCounter = useRef({
    _id: 0,
    nextId() {
      return this._id++;
    },
  }).current;

  const executePlayerMethod = useCallback(
    (methodName, methodArguments = []) => {
      if (!Array.isArray(methodArguments)) {
        throw new Error('methodArguments must be an array');
      }

      if (webViewRef.current) {
        const executionId = executionCounter.nextId();
        webViewRef.current.postMessage(
          JSON.stringify({
            eventType: 'executePlayerMethod',
            data: {
              id: executionId,
              method: methodName,
              args: methodArguments,
            },
          }),
          '*',
        );
        return new Promise((resolve, reject) => {
          // todo: consider adding a timeout here to reject the promise
          //       after x seconds of not receiving a response;
          eventEmitter.current.once(
            `playerMethodExecuted(${executionId})`,
            event => {
              if (event.error) {
                reject(event.error);
              } else {
                resolve(event.result);
              }
            },
          );
        });
      } else {
        console.error('Missing webview ref! Unable to send message to iframe.');
        return Promise.reject('Missing webview ref!');
      }
    },
    [executionCounter],
  );

  const [playerController, setPlayerController] = useState({
    supportedApiMethods: [],
  });
  const playerControllerRef = useRef(playerController);

  const initializePlayerController = useCallback(
    onReadyMessageData => {
      console.log(
        'YoutubeIframe:110 - initializePlayerController - onReadyMessageData',
        onReadyMessageData,
      );
      if (!Array.isArray(onReadyMessageData?.supportedApiMethods)) {
        throw new Error(
          'onReadyMessageData must have supportedApiMethods array',
        );
      }

      const newPlayerController = {
        ...Object.fromEntries(
          onReadyMessageData.supportedApiMethods.map(method => {
            return [method, (...args) => executePlayerMethod(method, args)];
          }),
        ),
        supportedApiMethods: Object.freeze([
          ...onReadyMessageData.supportedApiMethods,
        ]),
      };
      playerControllerRef.current = newPlayerController;
      setPlayerController(newPlayerController);
    },
    [executePlayerMethod],
  );

  useImperativeHandle(ref, () => playerController, [playerController]);

  useEffect(() => {
    if (!playerReady) {
      // no instance of player is ready
      return;
    }
    if (play) {
      playerControllerRef.current.playVideo();
    } else {
      playerControllerRef.current.pauseVideo();
    }
    if (mute) {
      playerControllerRef.current.mute();
    } else {
      playerControllerRef.current.unMute();
    }

    playerControllerRef.current.setVolume(volume);
    playerControllerRef.current.setPlaybackRate(playbackRate);
  }, [play, mute, volume, playbackRate, playerReady]);

  useEffect(() => {
    if (!playerReady || lastVideoIdRef.current === videoId) {
      // no instance of player is ready
      // or videoId has not changed
      return;
    }

    lastVideoIdRef.current = videoId;

    // webViewRef.current.injectJavaScript(
    //   PLAYER_FUNCTIONS.loadVideoById(videoId, play),
    // );
  }, [videoId, play, playerReady]);

  useEffect(() => {
    if (!playerReady) {
      // no instance of player is ready
      return;
    }

    // Also, right now, we are helping users by doing "deep" comparisons of playList prop,
    // but in the next major we should leave the responsibility to user (either via useMemo or moving the array outside)
    if (!playList || deepComparePlayList(lastPlayListRef.current, playList)) {
      return;
    }

    lastPlayListRef.current = playList;

    const index = playListStartIndex || 0;
    const func = play ? 'loadPlaylist' : 'cuePlaylist';

    const list = typeof playList === 'string' ? `"${playList}"` : 'undefined';
    const playlist = Array.isArray(playList)
      ? `"${playList.join(',')}"`
      : 'undefined';
    const listType =
      typeof playList === 'string' ? `"${playlist}"` : 'undefined';

    playerControllerRef.current[func]({listType, list, playlist, index});
  }, [playList, play, playListStartIndex, playerReady]);

  const onWebMessage = useCallback(
    event => {
      console.log('onWebMessage in lib', event);
      try {
        const message = JSON.parse(event.nativeEvent.data);

        switch (message.eventType) {
          case 'fullScreenChange':
            onFullScreenChange(message.data);
            break;
          case 'playerStateChange':
            onChangeState(PLAYER_STATES[message.data]);
            break;
          case 'playerReady':
            initializePlayerController(message.data);
            setPlayerReady(true);
            onReady();
            break;
          case 'playerQualityChange':
            onPlaybackQualityChange(message.data);
            break;
          case 'playerError':
            onError(PLAYER_ERROR[message.data]);
            break;
          case 'playbackRateChange':
            onPlaybackRateChange(message.data);
            break;
          case 'Console':
            console[message.data.type](`[WebViewConsole]`, ...message.data.log);
          default:
            eventEmitter.current.emit(message.eventType, message.data);
            break;
        }
      } catch (error) {
        console.warn('[rn-youtube-iframe]', error);
      }
    },
    [
      onFullScreenChange,
      onChangeState,
      onReady,
      initializePlayerController,
      onPlaybackQualityChange,
      onError,
      onPlaybackRateChange,
    ],
  );

  const onShouldStartLoadWithRequest = useCallback(
    request => {
      try {
        const url = request.mainDocumentURL || request.url;
        if (Platform.OS === 'ios') {
          const iosFirstLoad = url === 'about:blank';
          if (iosFirstLoad) {
            return true;
          }
          const isYouTubeLink = url.startsWith('https://www.youtube.com/');
          if (isYouTubeLink) {
            Linking.openURL(url).catch(error => {
              console.warn('Error opening URL:', error);
            });
            return false;
          }
        }
        return url.startsWith(baseUrlOverride || DEFAULT_BASE_URL);
      } catch (error) {
        // defaults to true in case of error
        // returning false stops the video from loading
        return true;
      }
    },
    [baseUrlOverride],
  );

  const source = useMemo(() => {
    const ytScript = MAIN_SCRIPT(
      lastVideoIdRef.current,
      lastPlayListRef.current,
      initialPlayerParamsRef.current,
      allowWebViewZoom,
      contentScale,
    );

    if (useLocalHTML) {
      const res = {html: ytScript.htmlString};
      if (baseUrlOverride) {
        res.baseUrl = baseUrlOverride;
      }
      return res;
    }

    const base = baseUrlOverride || DEFAULT_BASE_URL;
    const data = ytScript.urlEncodedJSON;

    return {uri: base + '?data=' + data};
  }, [useLocalHTML, contentScale, baseUrlOverride, allowWebViewZoom]);

  return (
    <View style={{height, width}}>
      <WebView
        injectedJavaScriptBeforeContentLoaded={`
  const consoleLog = (type, log) => window.ReactNativeWebView.postMessage(JSON.stringify({'eventType': 'Console', 'data': {'type': type, 'log': log}}));
  console = {
      log: (...log) => consoleLog('log', log),
      debug: (...log) => consoleLog('debug', log),
      info: (...log) => consoleLog('info', log),
      warn: (...log) => consoleLog('warn', log),
      error: (...log) => consoleLog('error', log),
    };
    console.log('WebView injectedJavaScript executed');
`}
        bounces={false}
        originWhitelist={['*']}
        allowsInlineMediaPlayback
        style={[styles.webView, webViewStyle]}
        mediaPlaybackRequiresUserAction={false}
        onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
        allowsFullscreenVideo={
          !initialPlayerParamsRef.current.preventFullScreen
        }
        userAgent={
          forceAndroidAutoplay
            ? Platform.select({android: CUSTOM_USER_AGENT, ios: ''})
            : ''
        }
        // props above this are override-able

        // --
        {...webViewProps}
        // --

        // add props that should not be allowed to be overridden below
        source={source}
        ref={webViewRef}
        onMessage={onWebMessage}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  webView: {backgroundColor: 'transparent'},
});

export default forwardRef(YoutubeIframe);
